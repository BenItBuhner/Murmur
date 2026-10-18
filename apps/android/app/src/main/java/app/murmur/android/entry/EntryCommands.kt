package app.murmur.android.entry

import android.content.Context
import android.content.Intent

/**
 * The intent surface external triggers fire at Murmur: Samsung RegiStar back taps, Modes and
 * Routines, launcher shortcuts, Tasker, the Quick Settings tile. Every one of them lands in
 * [DictationEntryActivity], which drives the same [app.murmur.android.dictation.DictationController]
 * the pill uses.
 *
 * Sample from Tasker ("Send Intent", target Activity, one of the four actions):
 * `adb shell am start -a app.murmur.android.action.TOGGLE_DICTATION`.
 */
object EntryActions {
    const val TOGGLE_DICTATION = "app.murmur.android.action.TOGGLE_DICTATION"
    const val START_DICTATION = "app.murmur.android.action.START_DICTATION"
    const val STOP_DICTATION = "app.murmur.android.action.STOP_DICTATION"
    const val CANCEL_DICTATION = "app.murmur.android.action.CANCEL_DICTATION"

    /** Every action the trampoline answers, in manifest order. */
    val ALL = listOf(TOGGLE_DICTATION, START_DICTATION, STOP_DICTATION, CANCEL_DICTATION)
}

/** The `app.murmur.android.extra.MODE` value: "hands-free" (the default when absent) or "command". */
object EntryModes {
    const val EXTRA = "app.murmur.android.extra.MODE"
    const val HANDS_FREE = "hands-free"
    const val COMMAND = "command"
}

/**
 * One command asked of Murmur from outside. [Toggle] starts a hands-free session when idle and
 * stops the one in flight; [Start] with [EntryCommand.command] set takes an instruction for the
 * selected text instead of dictating.
 */
sealed class EntryCommand {
    data object Toggle : EntryCommand()

    /** [command] is command mode (edit the selection), not hands-free dictation. */
    data class Start(val command: Boolean = false) : EntryCommand()

    data object Stop : EntryCommand()
    data object Cancel : EntryCommand()
}

/** Parsing and building of the entry intents; pure, so it can be tested without an activity. */
object EntryCommands {

    /** The command [intent] carries, or null when it is none of ours. */
    fun parse(intent: Intent?): EntryCommand? = when (intent?.action) {
        EntryActions.TOGGLE_DICTATION -> EntryCommand.Toggle
        EntryActions.START_DICTATION -> EntryCommand.Start(intent.getStringExtra(EntryModes.EXTRA) == EntryModes.COMMAND)
        EntryActions.STOP_DICTATION -> EntryCommand.Stop
        EntryActions.CANCEL_DICTATION -> EntryCommand.Cancel
        else -> null
    }

    /** An explicit intent for [command], aimed at the trampoline. */
    fun buildIntent(context: Context, command: EntryCommand): Intent {
        val intent = Intent(context, DictationEntryActivity::class.java)
        when (command) {
            EntryCommand.Toggle -> intent.action = EntryActions.TOGGLE_DICTATION
            is EntryCommand.Start -> {
                intent.action = EntryActions.START_DICTATION
                if (command.command) intent.putExtra(EntryModes.EXTRA, EntryModes.COMMAND)
            }
            EntryCommand.Stop -> intent.action = EntryActions.STOP_DICTATION
            EntryCommand.Cancel -> intent.action = EntryActions.CANCEL_DICTATION
        }
        return intent
    }
}
