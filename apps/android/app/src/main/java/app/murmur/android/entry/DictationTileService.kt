package app.murmur.android.entry

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import app.murmur.android.R
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * The "Dictate" Quick Settings tile. Tapping it fires the same TOGGLE at the trampoline every
 * other entry point uses — the tile never starts the microphone service itself, so the gates,
 * the keyguard and the debounce apply unchanged. While the system shows the tile (between
 * onStartListening and onStopListening) it mirrors the controller's state: active while a
 * dictation is in flight, with what stage it is at, inactive when idle.
 */
class DictationTileService : TileService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var mirror: Job? = null

    override fun onStartListening() {
        super.onStartListening()
        render()
        mirror = scope.launch {
            DictationController.state.collect { render() }
        }
    }

    override fun onStopListening() {
        super.onStopListening()
        mirror?.cancel()
        mirror = null
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun render() {
        val tile = qsTile ?: return
        val (state, subtitle) = tileLook(this, DictationController.state.value)
        tile.state = state
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && subtitle != null) {
            tile.subtitle = subtitle
        }
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        // The trampoline takes it from here: it starts recording while it is resumed (the
        // while-in-use rule), refuses when a gate is shut and unlocks the phone when it is locked.
        val toggle = EntryCommands.buildIntent(this, EntryCommand.Toggle)
        val collapse = {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val pending = PendingIntent.getActivity(
                    this, 0, toggle, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
                startActivityAndCollapse(pending)
            } else {
                @Suppress("DEPRECATION")
                startActivityAndCollapse(toggle.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            Unit
        }
        if (isLocked) unlockAndRun { collapse() } else collapse()
    }
}

/**
 * What the tile shows for a dictation state: active while one is in flight — "Listening…" while
 * it records, "Transcribing…" once the release is being processed — and inactive when idle.
 */
internal fun tileLook(context: Context, state: DictationState): Pair<Int, String?> = when (state) {
    is DictationState.Idle -> Tile.STATE_INACTIVE to null
    is DictationState.Listening -> Tile.STATE_ACTIVE to context.getString(R.string.tile_listening)
    else -> Tile.STATE_ACTIVE to context.getString(R.string.tile_transcribing)
}
