package app.murmur.android.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import app.murmur.android.MainActivity
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.dictation.Selection
import app.murmur.android.dictation.TextSink
import app.murmur.android.keyboard.HardwareShortcuts
import app.murmur.android.keyboard.KeyboardPresence
import app.murmur.android.keyboard.ShortcutRecorder
import app.murmur.android.keyboard.toEngineConfig
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayEditor
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.overlay.PillPresentation
import app.murmur.android.overlay.PillTheme
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.Route
import app.murmur.android.update.UpdateManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private const val TAG = "MurmurA11y"

/**
 * How long to keep looking for the focused field before giving up. Chromium hands the framework no
 * node provider for a page until the renderer has delivered the accessibility tree, which it only
 * builds once something asks for it, so the first lookup into a PWA or browser tab that just came to
 * the front can come back empty while a field is plainly focused; One UI likewise reports no active
 * window for a moment after an overlay was touched. A few short retries cover both.
 */
private const val TARGET_LOOKUP_ATTEMPTS = 5
private const val TARGET_LOOKUP_RETRY_MS = 90L

/**
 * Inserting text fires a burst of focus/selection events, and re-scanning the window list (an IPC
 * round trip) for each of them stalls the main thread exactly while the pill is morphing to
 * "Inserted". Those events only trigger a scan when the last one is older than this; window
 * events (the keyboard actually appearing or leaving) always scan.
 */
private const val WINDOW_SCAN_MIN_INTERVAL_MS = 120L

/**
 * After a sign that the keyboard is leaving, how long the pill stays aside if the keyboard does not
 * go: longer than a keyboard's slide out plus the report of it having gone.
 */
private const val LEAVE_GRACE_MS = 450L

/**
 * Height of the strip along the bottom edge where navigation buttons (and a keyboard's hide button)
 * live: a 48 dp navigation bar, with room for a maker's taller one.
 */
private const val NAV_STRIP_DP = 56f
/** How much of the field before the cursor the formatting model is shown. */
private const val PRECEDING_TEXT_MAX = 600

/**
 * The Wispr Flow pattern on Android: whenever the keyboard comes up, a floating dictation
 * button appears next to it (by default centred just above it; the user can park it anywhere,
 * including on the keyboard's own toolbar). Tap to dictate, tap again to stop; the transcribed,
 * cleaned text is inserted into the focused text field via accessibility actions.
 *
 * The pill view owns its geometry and animations and asks this service (its [OverlayPillView.Host])
 * for two windows: a canvas it draws in, which covers the screen, is never touchable and never
 * moves, and an invisible touch window that hugs the pill and relays taps to it. Where the keyboard
 * is comes from the accessibility window list ([KeyboardTracker]).
 *
 * With a physical keyboard attached (or on a tablet-sized screen) the overlay takes the desktop
 * app's form instead ([PillPresentation.Desktop]): a pill parked at the desktop's position with an
 * idle bar, driven by the same shortcuts as the desktop, which arrive here through the service's
 * key-event filter ([onKeyEvent], [HardwareShortcuts]). As on the desktop, the idle bar lets taps
 * through unless it is set (or, without a keyboard, needed) to start a dictation.
 *
 * This service is also the injection backend ([TextSink]); see [TextInserter] for the
 * ACTION_SET_TEXT / ACTION_SET_SELECTION / ACTION_PASTE strategy.
 */
class MurmurAccessibilityService : AccessibilityService(), TextSink, OverlayPillView.Host {

    private var windowManager: WindowManager? = null
    private var pill: OverlayPillView? = null
    private var shortcuts: HardwareShortcuts? = null
    private var presence: KeyboardPresence? = null
    private var presentation: PillPresentation = PillPresentation.Button

    /** Draws the pill. The whole screen, never touchable, never moved while the pill is shown. */
    private var canvasWindow: OverlayWindow? = null

    /** Invisible; hugs the pill and relays its touches. Free to follow the pill, nothing is drawn in it. */
    private var touchWindow: OverlayWindow? = null

    /** Where the keyboard is; its last top edge is kept while a dictation is in flight. */
    private val keyboard by lazy { KeyboardTracker(resources.displayMetrics.density, StoredKeyboardOffsets(this)) }
    private var lastKeyboardWindow: ImeWindow? = null
    private val arrivalCheck = Runnable { updateKeyboardState(force = true) }

    /**
     * Something said the keyboard is about to go (its hide button, Back, another app coming up). The
     * keyboard's slide out is only reported once it is over, so the pill steps aside on these instead;
     * if the keyboard is still there a moment later, it comes back.
     */
    private var leaving = false
    private val leaveCheck = Runnable {
        updateKeyboardState(force = true)
        if (keyboard.visible) keyboardStaying()
    }
    private var lastWindowScanAt = 0L
    private var lastEditable: AccessibilityNodeInfo? = null
    private var lastPackage: String = ""
    private val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        DictationController.sink = this
        // The keyboard's window arriving or leaving is reported the moment it happens; a notification
        // timeout would hold that report back, and the pill with it. Taps on the keyboard's own hide
        // button come as clicks. Installs whose service was bound with an older configuration pick
        // both up here.
        serviceInfo?.let { info ->
            val types = info.eventTypes or AccessibilityEvent.TYPE_VIEW_CLICKED
            if (info.notificationTimeout != 0L || info.eventTypes != types) {
                info.notificationTimeout = 0L
                info.eventTypes = types
                serviceInfo = info
            }
        }
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        val settings = SettingsStore.get(this)
        val presence = KeyboardPresence.get(this).also { this.presence = it }
        val shortcuts = HardwareShortcuts(settings.get().keyboard.toEngineConfig()) { action ->
            DictationController.handle(this, action)
        }
        this.shortcuts = shortcuts
        presentation = PillPresentation.resolve(settings.get().keyboard, presence.posture.value)
        mainScope.launch {
            DictationController.state.collect { state ->
                pill?.render(state)
                val listening = state as? DictationState.Listening
                shortcuts.syncSession(listening != null, listening?.mode, SystemClock.uptimeMillis())
                // Keep the pill on screen while a dictation is in flight even if the
                // keyboard gets dismissed underneath it.
                if (state !is DictationState.Idle) showPill() else syncPillVisibility()
            }
        }
        mainScope.launch {
            settings.flow.collect { s ->
                pill?.setPalette(PillTheme.resolve(this@MurmurAccessibilityService, s))
                pill?.configure(s.overlayShape, s.overlayLayout)
                shortcuts.applyConfig(s.keyboard.toEngineConfig())
                applyPresentation()
            }
        }
        mainScope.launch {
            presence.posture.collect { posture ->
                // A keyboard that went away mid-chord never sends its releases.
                if (!posture.hardwareKeyboard) shortcuts.reset()
                applyPresentation()
            }
        }
        mainScope.launch {
            OverlayEditor.editing.collect { editing ->
                if (editing) showPill()
                pill?.setEditing(editing)
                syncPillVisibility()
            }
        }
        mainScope.launch {
            ShortcutRecorder.session.collect { session ->
                if (session != null) shortcuts.startCapture { ShortcutRecorder.publish(it) } else shortcuts.stopCapture()
            }
        }
        // The only long-lived part of the app: the daily update check lives here. An unattended
        // install waits until no dictation is in flight and the keyboard is away.
        UpdateManager.get(this).apply {
            isIdle = { DictationController.state.value is DictationState.Idle && !keyboard.visible }
            startBackgroundChecks(mainScope)
        }
        Log.i(TAG, "accessibility service connected")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        if (DictationController.sink === this) DictationController.sink = null
        OverlayEditor.stop()
        ShortcutRecorder.stop()
        shortcuts = null
        mainHandler.removeCallbacks(arrivalCheck)
        mainHandler.removeCallbacks(leaveCheck)
        removePill()
        mainScope.cancel()
        super.onDestroy()
    }

    override fun onInterrupt() = Unit

    /**
     * A new wallpaper (or dark mode flip) arrives as a configuration change; so does a keyboard
     * being attached or detached, and a change of window size (a fold, a DeX session).
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        pill?.setPalette(PillTheme.resolve(this, SettingsStore.get(this).get()))
        presence?.refresh(newConfig)
    }

    /**
     * Hardware keys, before the rest of the system sees them. [HardwareShortcuts] decides what a key
     * does and whether it is taken; with shortcuts turned off nothing is filtered (the recorder
     * still captures, since a capture is how the shortcuts get set in the first place).
     */
    override fun onKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK) onBackKey(event)
        val shortcuts = shortcuts ?: return false
        if (!SettingsStore.get(this).get().keyboard.shortcuts && !shortcuts.isCapturing) return false
        return shortcuts.onKeyEvent(event, SystemClock.uptimeMillis())
    }

    /** The presentation the settings and the device call for right now; a change morphs the pill over. */
    private fun applyPresentation() {
        val posture = presence?.posture?.value ?: return
        val next = PillPresentation.resolve(SettingsStore.get(this).get().keyboard, posture)
        if (next == presentation) return
        presentation = next
        if (next !is PillPresentation.Button) OverlayEditor.stop()
        pill?.setPresentation(next)
        syncPillVisibility()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        when (event.eventType) {
            AccessibilityEvent.TYPE_VIEW_FOCUSED,
            AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED -> {
                val source = event.source ?: return
                if (source.acceptsText()) {
                    lastEditable = source
                    lastPackage = event.packageName?.toString() ?: lastPackage
                }
                updateKeyboardState(force = false)
            }
            AccessibilityEvent.TYPE_VIEW_CLICKED -> if (keyboard.visible && isKeyboardDismissButton(event)) keyboardLeaving()
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                if (keyboard.visible && isAnotherAppComingUp(event)) keyboardLeaving()
                updateKeyboardState(force = true)
            }
            AccessibilityEvent.TYPE_WINDOWS_CHANGED -> updateKeyboardState(force = true)
        }
    }

    /**
     * A hardware Back key while the keyboard is up closes the keyboard (Android hands it to the
     * keyboard first), so it is seen here as the key goes down, before the keyboard starts to slide; a
     * press that is cancelled leaves it up. Only real keys pass through this filter: the on-screen
     * back buttons and the back gesture inject theirs straight into the input dispatcher.
     */
    private fun onBackKey(event: KeyEvent) {
        when {
            event.action == KeyEvent.ACTION_UP && event.isCanceled -> keyboardStaying()
            event.repeatCount == 0 && keyboard.visible -> keyboardLeaving()
        }
    }

    /**
     * A tap on the keyboard's own way out, reported as the finger lifts, right after the button has
     * told the keyboard to go: the back button of the navigation bar a keyboard draws under its keys
     * (Android's `input_method_nav_back`, a down chevron while the keyboard is up), the system bar's
     * back button, or a maker's hide-keyboard button in that strip: a small button along the bottom
     * edge, in the keyboard's window or a system window. Not a keyboard switcher, nor the
     * accessibility button, which leave the keyboard up.
     */
    private fun isKeyboardDismissButton(event: AccessibilityEvent): Boolean {
        val source = event.source ?: return false
        val id = source.viewIdResourceName.orEmpty()
        if ("switcher" in id || id.endsWith("accessibility_button")) return false
        if (id.endsWith(":id/input_method_nav_back") || id == "com.android.systemui:id/back") return true
        val type = runCatching { windows.firstOrNull { it.id == event.windowId }?.type }.getOrNull()
        if (type != AccessibilityWindowInfo.TYPE_INPUT_METHOD && type != AccessibilityWindowInfo.TYPE_SYSTEM) return false
        val bounds = Rect().also { source.getBoundsInScreen(it) }
        val strip = NAV_STRIP_DP * resources.displayMetrics.density
        return bounds.top >= screenSize().second - strip && bounds.height() <= strip && bounds.width() <= 2 * strip
    }

    /**
     * Another app's window coming up (the launcher for Recents or home, an app switched to) takes the
     * keyboard down with the one it belonged to. The keyboard (and its panels), the system UI and
     * Murmur itself do not count, nor the app being typed into; nothing counts before that app is known.
     */
    private fun isAnotherAppComingUp(event: AccessibilityEvent): Boolean {
        if (event.contentChangeTypes != 0 || lastPackage.isEmpty()) return false
        val pkg = event.packageName?.toString()?.takeIf { it.isNotEmpty() } ?: return false
        if (pkg == lastPackage || pkg == packageName || pkg == lastKeyboardWindow?.packageName) return false
        if (pkg == "com.android.systemui" || pkg == "android") return false
        val type = runCatching { windows.firstOrNull { it.id == event.windowId }?.type }.getOrNull()
        return type != AccessibilityWindowInfo.TYPE_INPUT_METHOD
    }

    private fun keyboardLeaving() {
        if (!leaving) {
            leaving = true
            syncPillVisibility()
        }
        mainHandler.removeCallbacks(leaveCheck)
        mainHandler.postDelayed(leaveCheck, LEAVE_GRACE_MS)
    }

    private fun keyboardStaying() {
        mainHandler.removeCallbacks(leaveCheck)
        if (!leaving) return
        leaving = false
        syncPillVisibility()
    }

    // ---- keyboard tracking ----------------------------------------------------------------

    private fun updateKeyboardState(force: Boolean) {
        val now = SystemClock.uptimeMillis()
        if (!force && now - lastWindowScanAt < WINDOW_SCAN_MIN_INTERVAL_MS) return
        lastWindowScanAt = now
        val wasVisible = keyboard.visible
        keyboard.update(keyboardWindow(), now, screenSize().second.toFloat())
        mainHandler.removeCallbacks(arrivalCheck)
        keyboard.arrivalDeadline?.let { mainHandler.postAtTime(arrivalCheck, it) }
        // A keyboard that has gone, or a new one arriving, starts from a clean slate.
        if (keyboard.visible != wasVisible && leaving) {
            leaving = false
            mainHandler.removeCallbacks(leaveCheck)
        }
        syncPillVisibility()
    }

    /**
     * The keyboard's window in the current window list, with the frame its views are laid out in.
     * The frame is read from the window's root (a round trip to the keyboard's process) only when
     * the reported bounds changed; a window list that did not move the keyboard reuses it.
     */
    private fun keyboardWindow(): ImeWindow? {
        val ime = try {
            windows.filter { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
                .maxByOrNull { w -> Rect().also { w.getBoundsInScreen(it) }.height() }
        } catch (e: Exception) {
            Log.w(TAG, "window scan failed", e)
            null
        }
        if (ime == null) {
            lastKeyboardWindow = null
            return null
        }
        val bounds = Rect().also { ime.getBoundsInScreen(it) }.toBox()
        val last = lastKeyboardWindow
        if (last != null && last.id == ime.id && last.bounds == bounds && last.frame != null) return last
        val root = runCatching { ime.root }.getOrNull()
        val frame = root?.let { r -> Rect().also { r.getBoundsInScreen(it) } }?.takeIf { !it.isEmpty }?.toBox()
        return ImeWindow(ime.id, bounds, frame, root?.packageName?.toString()).also { lastKeyboardWindow = it }
    }

    /**
     * The floating button shows with the keyboard, but only where it rests: fully there the moment
     * the keyboard's resting edge is known (from its first report, still sliding in, when the
     * keyboard has been seen before), and stepping aside within two frames the moment anything says
     * the keyboard is leaving or has been pulled well down. The desktop pill stays as its idle bar
     * (unless the idle indicator is off). Both stay for a dictation in flight and the button for its
     * editor.
     */
    private fun syncPillVisibility() {
        val busy = DictationController.state.value !is DictationState.Idle
        when (val p = presentation) {
            is PillPresentation.Desktop -> if (busy || p.showIdle) showPill() else removePill()
            PillPresentation.Button -> when {
                busy || OverlayEditor.editing.value -> showPill()
                keyboard.visible && keyboard.ready && !keyboard.displaced && !leaving -> showPill()
                keyboard.visible -> dismissPill()
                else -> removePill()
            }
        }
    }

    /** Fades the pill out where it is and drops its windows once it is gone. */
    private fun dismissPill() {
        val view = pill ?: return
        if (!view.isDismissing) view.dismiss { if (pill === view) removePill() }
    }

    /** Where the pill measures its vertical offset from: the keyboard's top edge, or the last known one while busy. */
    private fun keyboardReference(): Int? {
        if (keyboard.visible) return keyboard.top
        val busy = DictationController.state.value !is DictationState.Idle || OverlayEditor.editing.value
        return if (busy && keyboard.top > 0) keyboard.top else null
    }

    /** Shows the pill, drawn fully there from its first frame; one that was going comes back. */
    private fun showPill() {
        val wm = windowManager ?: return
        val (screenW, screenH) = screenSize()
        val existing = pill
        if (existing != null) {
            existing.setScreen(screenW, screenH, keyboardReference())
            if (existing.isDismissing) existing.appear()
            return
        }
        val settings = SettingsStore.get(this)
        val view = OverlayPillView(this).apply {
            host = this@MurmurAccessibilityService
            onMicTap = { DictationController.toggle(this@MurmurAccessibilityService) }
            onCancelTap = { DictationController.cancel(this@MurmurAccessibilityService) }
            onConfirmTap = { DictationController.stopAndInsert(this@MurmurAccessibilityService) }
            // The field the dictation was meant for is still focused: send the audio again into it.
            onRetryTap = { id -> DictationController.retry(this@MurmurAccessibilityService, id, insert = true) }
            onDismissTap = { DictationController.dismiss() }
            // The limit notice's ways forward: the web account page, or the Speech model screen.
            onUpgradeTap = { url -> openUrl(url); DictationController.dismiss() }
            onOwnModelTap = { openApp(Route.MODEL); DictationController.dismiss() }
            onLayoutChanged = { layout -> settings.update { it.copy(overlayLayout = layout) } }
            onEditDone = { OverlayEditor.stop() }
            onEditReset = { settings.update { it.copy(overlayLayout = settings.defaultOverlayLayout) } }
        }
        // Raw coordinates are display coordinates, which is the pill's own frame of reference, so
        // the relay does not depend on where the touch window happens to be at that instant.
        val relay = TouchRelayView(this) { ev -> view.onScreenTouch(ev, ev.rawX, ev.rawY) }
        pill = view
        canvasWindow = OverlayWindow(wm, view, touchable = false)
        touchWindow = OverlayWindow(wm, relay, touchable = true)
        val s = settings.get()
        view.setPalette(PillTheme.resolve(this, s))
        view.configure(s.overlayShape, s.overlayLayout)
        view.setPresentation(presentation)
        view.setEditing(OverlayEditor.editing.value)
        // Computes the first frames and, through the Host callbacks, adds both windows.
        view.setScreen(screenW, screenH, keyboardReference())
        view.render(DictationController.state.value)
        if (canvasWindow?.attached != true || touchWindow?.attached != true) removePill()
    }

    override fun applyCanvasFrame(frame: Box) {
        canvasWindow?.place(frame)
    }

    override fun applyTouchFrame(frame: Box) {
        touchWindow?.place(frame)
    }

    override fun applyTouchable(touchable: Boolean) {
        touchWindow?.setTouchable(touchable)
    }

    private fun removePill() {
        touchWindow?.remove()
        canvasWindow?.remove()
        touchWindow = null
        canvasWindow = null
        pill = null
    }

    private fun screenSize(): Pair<Int, Int> {
        val wm = windowManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && wm != null) {
            val bounds = wm.currentWindowMetrics.bounds
            return bounds.width() to bounds.height()
        }
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm?.defaultDisplay?.getRealMetrics(metrics)
        if (metrics.widthPixels <= 0 || metrics.heightPixels <= 0) {
            val dm = resources.displayMetrics
            return dm.widthPixels to dm.heightPixels
        }
        return metrics.widthPixels to metrics.heightPixels
    }

    // ---- TextSink ---------------------------------------------------------------------------

    override fun focusedPackage(): String {
        val root = rootInActiveWindow
        return root?.packageName?.toString() ?: lastPackage
    }

    /**
     * What is already in the field before the cursor, so the model can continue it (no capital
     * mid-sentence, an ongoing list keeps its markers, the same language). Read on the main thread
     * like every other node interrogation; null when there is no field or the field hides its text.
     */
    override suspend fun precedingText(): String? = withContext(Dispatchers.Main.immediate) {
        val node = runCatching { findEditableTarget() }.getOrNull() ?: return@withContext null
        if (node.isPassword || node.isShowingHintText) return@withContext null
        val text = node.text?.toString()?.takeIf { it.isNotEmpty() } ?: return@withContext null
        val caret = node.textSelectionStart.takeIf { it in 0..text.length } ?: text.length
        text.substring(0, caret).takeIf { it.isNotBlank() }?.takeLast(PRECEDING_TEXT_MAX)
    }

    /**
     * Command mode: what is selected in the focused field, from the node's own selection offsets.
     * Null when no field is focused, the field hides its text, or nothing (or only whitespace) is
     * selected. Web content reports approximate offsets; they are still what the edit replaces.
     */
    override suspend fun readSelection(): Selection? = withContext(Dispatchers.Main.immediate) {
        val node = runCatching { findEditableTarget() }.getOrNull() ?: return@withContext null
        if (node.isPassword || node.isShowingHintText) return@withContext null
        val text = node.text?.toString() ?: return@withContext null
        val a = node.textSelectionStart
        val b = node.textSelectionEnd
        if (a < 0 || b < 0 || a == b) return@withContext null
        val start = min(a, b)
        val end = max(a, b)
        if (end > text.length) return@withContext null
        val selected = text.substring(start, end)
        if (selected.isBlank()) null else Selection(selected, start, end)
    }

    /**
     * Command mode: put the model's answer where the selection was. The selection is put back
     * first if the field lost it while the instruction was spoken; the insertion strategy then
     * replaces the selected range (`ACTION_SET_TEXT` splices over it, `ACTION_PASTE` and an IME
     * commit replace it natively). A field whose text has changed underneath is left alone.
     */
    override suspend fun replaceSelection(selection: Selection, text: String): String? =
        withContext(Dispatchers.Main.immediate) {
            val node = awaitEditableTarget()
            if (node == null) {
                copyToClipboard(text)
                return@withContext COPIED_NO_FIELD
            }
            val current = node.text?.toString() ?: ""
            val stillThere = selection.end <= current.length && current.substring(selection.start, selection.end) == selection.text
            if (!stillThere) {
                copyToClipboard(text)
                return@withContext COPIED_SELECTION_CHANGED
            }
            if (node.textSelectionStart != selection.start || node.textSelectionEnd != selection.end) {
                val args = Bundle().apply {
                    putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, selection.start)
                    putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, selection.end)
                }
                if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, args)) {
                    Log.w(TAG, "field refused to restore the selection; the edit goes in at the cursor")
                }
            }
            val (keyboard, keyboardStatus) = keyboardSupport(SettingsStore.get(this@MurmurAccessibilityService).get())
            when (val outcome = TextInserter.insert(NodeTarget(node), text, false, ::copyToClipboard, keyboard, keyboardStatus)) {
                is InsertOutcome.Inserted -> {
                    Log.i(TAG, "replaced ${selection.text.length} selected chars with ${text.length} via ${outcome.method}")
                    null
                }
                is InsertOutcome.Failed -> outcome.message
            }
        }

    /**
     * Accessibility node calls are plain binder IPC and work from any thread, but the framework
     * caches node state per thread and same-process interrogation (our own test pad) is only
     * short-circuited on the main thread, so the whole insertion runs there.
     */
    override suspend fun insert(text: String, pressEnter: Boolean): String? =
        withContext(Dispatchers.Main.immediate) {
            // The node may be null in a terminal: it takes IME input through a custom view but
            // exposes no editable accessibility node. Keyboard support (when on and connected) is
            // what reaches it, so the two are resolved together and handed to the strategy.
            val node = awaitEditableTarget()
            val (keyboard, keyboardStatus) = keyboardSupport(SettingsStore.get(this@MurmurAccessibilityService).get())
            val target = node?.let { NodeTarget(it) }
            when (val outcome = TextInserter.insert(target, text, pressEnter, ::copyToClipboard, keyboard, keyboardStatus)) {
                is InsertOutcome.Inserted -> {
                    val where = when {
                        node == null -> "keyboard support"
                        target?.isWebContent == true -> "${node.packageName} (web content)"
                        else -> node.packageName.toString()
                    }
                    Log.i(TAG, "inserted ${text.length} chars via ${outcome.method} into $where")
                    null
                }
                is InsertOutcome.Failed -> {
                    Log.w(TAG, "insertion failed [$keyboardStatus]: ${outcome.message}")
                    outcome.message
                }
            }
        }

    /**
     * Whether the Android 13+ accessibility input-method connection can carry this dictation, and
     * why not when it cannot. Off below API 33; otherwise resolved from the live IME connection (see
     * [accessibilityKeyboard]). The "experimental keyboard support" setting gates its use, but the
     * connection is still inspected when the setting is off so the notice can suggest turning it on.
     */
    private fun keyboardSupport(settings: MurmurSettings): Pair<KeyboardInput?, KeyboardStatus> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return null to if (settings.experimentalKeyboard) KeyboardStatus.UNSUPPORTED else KeyboardStatus.OFF
        }
        return accessibilityKeyboard(this, settings.experimentalKeyboard)
    }

    private suspend fun awaitEditableTarget(): AccessibilityNodeInfo? =
        retryLookup(TARGET_LOOKUP_ATTEMPTS, TARGET_LOOKUP_RETRY_MS) { attempt ->
            findEditableTarget().also {
                if (it == null && attempt < TARGET_LOOKUP_ATTEMPTS - 1) {
                    Log.d(TAG, "no focused field yet (attempt ${attempt + 1}); retrying")
                }
            }
        }

    /**
     * The field the dictation belongs in. The input-focused node of the active window is the
     * normal answer; when the system has no active window for a moment (One UI does this right
     * after an overlay was touched) every application window is checked, and the field that most
     * recently reported focus is the last resort, provided it belongs to the app in front: a
     * remembered field from an app that is still alive in the background must not swallow a
     * dictation meant for the one the user is looking at.
     */
    private fun findEditableTarget(): AccessibilityNodeInfo? {
        focusedEditable(rootInActiveWindow)?.let { return it }
        val visible = try {
            windows
        } catch (e: Exception) {
            Log.w(TAG, "window scan failed", e)
            emptyList()
        }
        // Windows come top-most first; the focused application window, or failing that the one on
        // top, is the app the user is looking at. (The active window itself may be the keyboard.)
        var frontPackage: String? = null
        for (w in visible.sortedByDescending { it.isFocused }) {
            if (w.type != AccessibilityWindowInfo.TYPE_APPLICATION) continue
            val root = runCatching { w.root }.getOrNull() ?: continue
            if (frontPackage == null) frontPackage = root.packageName?.toString()
            focusedEditable(root)?.let { return it }
        }
        val remembered = lastEditable ?: return null
        if (!runCatching { remembered.refresh() }.getOrDefault(false) || !remembered.acceptsText()) return null
        val rememberedPackage = remembered.packageName?.toString()
        if (frontPackage != null && rememberedPackage != frontPackage) {
            Log.d(TAG, "ignoring remembered field of $rememberedPackage; $frontPackage is in front")
            return null
        }
        return remembered
    }

    private fun focusedEditable(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        val focus = runCatching { root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull() ?: return null
        return if (focus.acceptsText()) focus else null
    }

    private fun copyToClipboard(text: String) {
        val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Murmur dictation", text))
    }

    /** The web account page, in the browser. Only https links, and only from the pill's own state. */
    private fun openUrl(url: String) {
        if (!url.startsWith("https://")) return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.w(TAG, "could not open $url", e)
        }
    }

    /** Bring Murmur to the front on [route]. */
    private fun openApp(route: Route) {
        try {
            startActivity(MainActivity.intentFor(this, route).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.w(TAG, "could not open Murmur", e)
        }
    }

    companion object {
        @Volatile
        var instance: MurmurAccessibilityService? = null
            private set

        val isRunning: Boolean get() = instance != null

        /**
         * Whether the system lets this service filter key events. The capability is read when the
         * service is enabled, so an install that gained it in an update needs the service turned
         * off and on once; the Keyboard screen says so while this is false.
         */
        val canFilterKeys: Boolean
            get() {
                val info = runCatching { instance?.serviceInfo }.getOrNull() ?: return false
                return (info.capabilities and AccessibilityServiceInfo.CAPABILITY_CAN_REQUEST_FILTER_KEY_EVENTS) != 0
            }
    }
}

/**
 * One accessibility-overlay window placed in screen coordinates. A non-touchable window is skipped
 * by input dispatch entirely, so the pill's canvas can be as large as it likes without stealing
 * taps from the keyboard underneath it.
 */
private class OverlayWindow(private val wm: WindowManager, private val view: View, touchable: Boolean) {
    private val params = WindowManager.LayoutParams(
        1,
        1,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            (if (touchable) 0 else WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE),
        PixelFormat.TRANSLUCENT
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        x = 0
        y = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        // A window that is moved and resized at once is otherwise eased to its new place over
        // WindowManager's move animation, and its touch area travels with it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) setCanPlayMoveAnimation(false)
    }

    var attached = false
        private set

    /** Off, the window is skipped by input dispatch: a tap on it goes to whatever is underneath. */
    fun setTouchable(touchable: Boolean) {
        val flags = if (touchable) {
            params.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        } else {
            params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        }
        if (flags == params.flags) return
        params.flags = flags
        if (!attached) return
        try {
            wm.updateViewLayout(view, params)
        } catch (e: Exception) {
            Log.e(TAG, "failed to update overlay window", e)
        }
    }

    fun place(frame: Box) {
        params.x = frame.left.roundToInt()
        params.y = frame.top.roundToInt()
        params.width = max(1, frame.width.roundToInt())
        params.height = max(1, frame.height.roundToInt())
        try {
            if (!attached) {
                wm.addView(view, params)
                attached = true
            } else {
                wm.updateViewLayout(view, params)
            }
        } catch (e: Exception) {
            Log.e(TAG, "failed to place overlay window", e)
        }
    }

    fun remove() {
        if (!attached) return
        attached = false
        try {
            wm.removeView(view)
        } catch (_: Exception) {
        }
    }
}

private fun Rect.toBox(): Box = Box(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat())

/**
 * Keyboards' resting offsets, kept across restarts so a keyboard's resting edge is known from the
 * first report of it after a reboot or an update. Stored in dp, so a change of screen resolution does
 * not skew them; only keyboards identified by their app are kept.
 */
private class StoredKeyboardOffsets(private val context: Context) : KeyboardOffsets {
    private val prefs = context.getSharedPreferences("keyboard_offsets", Context.MODE_PRIVATE)
    private val density: Float get() = context.resources.displayMetrics.density

    override fun get(keyboard: String): Float? =
        if (prefs.contains(keyboard)) prefs.getFloat(keyboard, 0f) * density else null

    override fun set(keyboard: String, offset: Float) {
        if (keyboard.startsWith("window:")) return
        prefs.edit().putFloat(keyboard, offset / density).apply()
    }
}

/** Draws nothing; hands every touch to the pill, which does its own hit-testing in screen space. */
private class TouchRelayView(context: Context, private val relay: (MotionEvent) -> Boolean) : View(context) {
    override fun onTouchEvent(event: MotionEvent): Boolean = relay(event)

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }
}
