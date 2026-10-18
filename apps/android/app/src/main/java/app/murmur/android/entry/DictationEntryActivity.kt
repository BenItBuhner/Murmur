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
 * launcher shortcuts, Tasker, the Quick Settings tile. It checks the gates, hands the command to
 * DictationController while it is resumed — Android 14/15 only let an app that is in front start
 * the microphone foreground service — and vanishes at once: fully transparent, no transition,
 * never in Recents. The accessibility service shows the pill the moment the controller leaves
 * Idle, so the overlay needs no new code here.
 *
 * `Theme.NoDisplay` never reaches onResume, which is exactly what must not happen (the controller
 * is called from the resumed trampoline, and the FGS start from it), so the theme is translucent
 * instead.
 */
open class DictationEntryActivity : Activity() {

    /** Whether the activity is between onResume and onPause right now. */
    private var resumed = false

    /** The intent whose command has been taken, so a re-resume (the keyguard flow) cannot take it twice. */
    private var takenIntent: Intent? = null

    /** Bumped by every command; a keyguard dismissal answers only the latest one. */
    private var generation = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Nothing is drawn and nothing is set as content: the theme is fully transparent.
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        takeCurrent()
    }

    override fun onPause() {
        resumed = false
        super.onPause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // A live instance gets the next trigger here; one still being born gets it through onResume.
        if (resumed && !isFinishing) takeCurrent()
    }

    /** Takes the current intent's command, once per intent. */
    private fun takeCurrent() {
        val current = intent
        if (current === takenIntent) return
        takenIntent = current
        if (current == null) return finishQuietly()
        val command = EntryCommands.parse(current) ?: return finishQuietly()
        val mine = ++generation
        // Triggers double-fire for one gesture (Samsung's back tap above all); the second within
        // the window is ignored, so one tap is one command.
        if (debounced()) return finishQuietly()
        if (keyguardLocked()) {
            // The lock screen first; the command runs only once the user got past it.
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

    /** The package of the home app the phone resolves to. */
    private fun defaultLauncherPackage(): String? = runCatching {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        packageManager.resolveActivity(home, 0)?.activityInfo?.packageName
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
                    // session (and the microphone service) starts now, while this activity is
                    // resumed; only the selection read waits until the trampoline is gone
                    // (selectionDelayMs), when the field the user had focused is in front again.
                    // Best effort: a field whose app has not settled again in time reads as no
                    // selection and the session ends with the "select some text" notice.
                    DictationController.start(this, DictationMode.COMMAND, selectionDelayMs = COMMAND_SELECTION_DELAY_MS)
                } else {
                    DictationController.start(this, DictationMode.HANDS_FREE)
                }
            EntryCommand.Stop -> DictationController.stopAndInsert(this)
            EntryCommand.Cancel -> DictationController.cancel(this)
        }
        finishQuietly()
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

        @Volatile
        private var lastCommandAt = 0L

        /** @return true when this command came too soon after the previous one. */
        internal fun debounced(now: Long = SystemClock.elapsedRealtime()): Boolean {
            val last = lastCommandAt
            if (now - last < DEBOUNCE_MS) return true
            lastCommandAt = now
            return false
        }

        /** Tests start from a clean window. */
        internal fun resetDebounce() {
            lastCommandAt = 0L
        }
    }
}
