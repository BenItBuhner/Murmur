package app.murmur.android.entry

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.widget.Toast
import app.murmur.android.MainActivity
import app.murmur.android.R
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationMode
import app.murmur.android.dictation.DictationState
import app.murmur.android.service.MurmurAccessibilityService
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.Route

/**
 * The trampoline external triggers land in: Samsung RegiStar back taps, Modes and Routines,
 * launcher shortcuts, Tasker, the Quick Settings tile. It takes the command, hands it to
 * DictationController, and finishes — all inside onCreate, before a window ever exists, so the
 * accessibility service shows the pill over the app the user is in the moment the controller
 * leaves Idle.
 *
 * Shortcuts are fired by the system with FLAG_ACTIVITY_TASK_ON_HOME (ShortcutParser adds
 * NEW_TASK | CLEAR_TASK | TASK_ON_HOME to a shortcut's intent). The moment such a task comes to
 * the front the system moves the HOME screen up right behind it (Task.moveToFront →
 * moveHomeRootTaskToFront), so the app the user was in is pushed behind the launcher before this
 * activity's onCreate even runs: to the user it looks as if their app was closed. Nothing done
 * inside this activity can undo that move, so every exit that is not a lock-screen or gate path
 * puts the app the user was in ([MurmurAccessibilityService.appToReturnTo]) back in front, the
 * same way its launcher icon does, and this activity's own exit happens behind it. That includes
 * the ignored second fire of a double-firing trigger: it moved home to the front again too.
 *
 * The command needs no resumed activity: the gates require the accessibility service to be
 * running, and the microphone foreground service starts exactly the way it does from the pill,
 * from that service.
 */
open class DictationEntryActivity : Activity() {

    /** Set while a keyguard dismissal holds the command; its task juggling is skipped then. */
    private var heldByLockScreen = false

    /** The intent whose command has been taken, so a re-delivery cannot take it twice. */
    private var takenIntent: Intent? = null

    /** Bumped by every command; a keyguard dismissal answers only the latest one. */
    private var generation = 0

    /** When this trampoline was created (uptimeMillis): window changes just before it are the launch's own. */
    private var createdAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        createdAt = SystemClock.uptimeMillis()
        super.onCreate(savedInstanceState)
        // Nothing is drawn and nothing is set as content: the command runs and this finishes
        // before the activity is ever started, let alone resumed.
        takeCurrent()
    }

    override fun onResume() {
        super.onResume()
        // Nothing to do here: commands run in onCreate, before a window exists. (The keyguard
        // flow runs its command from the dismiss callback.)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // A live instance gets the next trigger here; one still being born got it in onCreate.
        if (!isFinishing) takeCurrent()
    }

    /** Takes the current intent's command, once per intent. */
    private fun takeCurrent() {
        val current = intent
        if (current === takenIntent) return
        takenIntent = current
        heldByLockScreen = false
        if (current == null) return leave()
        val command = EntryCommands.parse(current) ?: return leave()
        // Triggers double-fire for one gesture (Samsung's back tap above all); the second within
        // the window is ignored, so one tap is one command. Its launch still moved home in front
        // of the user's app, so it leaves the same way a command does.
        if (debounced()) return leave()
        if (keyguardLocked()) {
            // The lock screen first: this one path shows the activity (behind the keyguard) and
            // runs the command only once the user got past it. No task juggling then — the user
            // is coming back through the lock screen anyway.
            heldByLockScreen = true
            val mine = ++generation
            requestKeyguardDismissed {
                if (generation == mine && !isFinishing) run(command)
            }
            return
        }
        run(command)
    }

    /**
     * Gates the command through, or shows why it cannot run (and where to fix it) and finishes.
     * Only a command that would start a session is gated: stopping or cancelling one in flight
     * never needs the microphone or a field.
     */
    private fun run(command: EntryCommand) {
        if (startsSession(command)) {
            refusal()?.let {
                Toast.makeText(this, getString(it.message), Toast.LENGTH_SHORT).show()
                openMurmur(it.home)
                finishQuietly()
                return
            }
        }
        execute(command)
    }

    private fun startsSession(command: EntryCommand): Boolean = when (command) {
        is EntryCommand.Start -> DictationController.state.value is DictationState.Idle
        EntryCommand.Toggle -> DictationController.state.value is DictationState.Idle
        EntryCommand.Stop, EntryCommand.Cancel -> false
    }

    /** The first gate that refuses the command, or null when it may run. */
    private fun refusal(): Refusal? {
        val settings = SettingsStore.get(this).get()
        if (!settings.onboardingComplete) return Refusal(R.string.entry_need_setup, home = true)
        if (!hasMic()) return Refusal(R.string.entry_need_mic)
        if (!MurmurAccessibilityService.isRunning) return Refusal(R.string.entry_need_accessibility)
        if (!settings.allowExternalTriggers && !callerAllowed()) return Refusal(R.string.entry_external_off)
        return null
    }

    private fun hasMic(): Boolean =
        checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** Our own package and the launcher the phone actually uses are always allowed to call. */
    private fun callerAllowed(): Boolean {
        val caller = launchedFrom()
        return caller == packageName || caller == defaultLauncherPackage()
    }

    /** Who fired this activity's intent, or null when the system will not say. Overridable for tests. */
    internal open fun launchedFrom(): String? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) getLaunchedFromPackage()
        else referrer?.host
    }.getOrNull()

    /**
     * The package of the home app the phone uses. MATCH_DEFAULT_ONLY: without it a phone with a
     * fallback home (the emulator's Settings has one) can resolve to the wrong package.
     */
    private fun defaultLauncherPackage(): String? = runCatching {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        packageManager.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
    }.getOrNull()

    private fun openMurmur(home: Boolean) {
        val intent = if (home) Intent(this, MainActivity::class.java)
        else MainActivity.intentFor(this, Route.PERMISSIONS)
        runCatching { startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    private fun execute(command: EntryCommand) {
        when (command) {
            EntryCommand.Toggle -> DictationController.toggle(this)
            is EntryCommand.Start ->
                if (command.command) {
                    // Command mode: the selection must be read in the user's app, not here. The
                    // session (and the microphone service) starts at once and only the selection
                    // read waits the short delay, when the field the user had focused is in front
                    // again. Best effort: a field whose app has not settled again in time reads
                    // as no selection and the session ends with the "select some text" notice.
                    DictationController.start(this, DictationMode.COMMAND, selectionDelayMs = COMMAND_SELECTION_DELAY_MS)
                } else {
                    DictationController.start(this, DictationMode.HANDS_FREE)
                }
            EntryCommand.Stop -> DictationController.stopAndInsert(this)
            EntryCommand.Cancel -> DictationController.cancel(this)
        }
        // The launch of this activity has already moved the home screen in front of the app the
        // user was in (shortcuts are fired with FLAG_ACTIVITY_TASK_ON_HOME), so finishing alone
        // would leave them on the launcher. Put their app back in front first.
        if (!heldByLockScreen) bringBackTheAppTheyWereIn()
        finishQuietly()
    }

    /** Finishes without running a command, after putting the user's app back in front. */
    private fun leave() {
        if (!heldByLockScreen && !keyguardLocked()) bringBackTheAppTheyWereIn()
        finishQuietly()
    }

    /**
     * Brings the task of the app the user was in back to the front, the way its launcher icon
     * does. Overridable so tests can watch it.
     *
     * Two things made this silently do nothing before: without the launcher-intent `<queries>`
     * in the manifest, Android 11+ package visibility hides every other app from us and
     * getLaunchIntentForPackage returns null; and without FLAG_ACTIVITY_RESET_TASK_IF_NEEDED a
     * task that was not started from its icon gets a fresh copy of its main screen stacked on
     * top instead of just coming forward.
     */
    internal open fun bringBackTheAppTheyWereIn() {
        val intent = returnIntent() ?: return
        runCatching { startActivity(intent) }
    }

    /** The launch that puts the user's app back in front, or null when there is nothing to return to. */
    internal fun returnIntent(): Intent? {
        val pkg = MurmurAccessibilityService.appToReturnTo(defaultLauncherPackage(), createdAt) ?: return null
        val launch = runCatching { packageManager.getLaunchIntentForPackage(pkg) }.getOrNull() ?: return null
        return launch.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED or
                Intent.FLAG_ACTIVITY_NO_ANIMATION
        )
    }

    private fun finishQuietly() = finish()

    // ---- keyguard --------------------------------------------------------------------------------

    /** Overridable so tests can lock and unlock the keyguard. */
    internal open fun keyguardLocked(): Boolean =
        (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked

    /**
     * Overridable so tests can answer it. On dismissal the command runs; when the user does not
     * get past the lock screen, nothing runs.
     */
    internal open fun requestKeyguardDismissed(run: () -> Unit) {
        val km = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
        km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() {
                if (!isFinishing) run()
                else finish()
            }

            override fun onDismissCancelled() {
                finish()
            }

            override fun onDismissError() {
                finish()
            }
        })
    }

    /** A gate's refusal: what to tell the user, and where in Murmur to take them. */
    private data class Refusal(val message: Int, val home: Boolean = false)

    companion object {
        /**
         * External triggers double-fire for one gesture; a command less than this after the
         * previous one is ignored. Gated or not, a command taken resets the window.
         */
        internal const val DEBOUNCE_MS = 400L

        /**
         * Command mode from an entry point: the selection is read this long after the trampoline
         * finished, when the user's app is in front again.
         */
        internal const val COMMAND_SELECTION_DELAY_MS = 150L

        /**
         * The last command taken, in nanoTime; 0 when there has been none yet. NanoTime, not
         * SystemClock.elapsedRealtime, because it is the one clock Robolectric does not pin at
         * boot (where the elapsed clock reads ~0 and every first command would look debounced).
         */
        @Volatile
        private var lastCommandAt = 0L

        /** @return true when this command came too soon after the previous one. */
        internal fun debounced(now: Long = System.nanoTime()): Boolean {
            val last = lastCommandAt
            if (last != 0L && now - last < DEBOUNCE_MS * 1_000_000) return true
            lastCommandAt = now
            return false
        }

        /** Tests start from a clean window. */
        internal fun resetDebounce() {
            lastCommandAt = 0L
        }
    }
}
