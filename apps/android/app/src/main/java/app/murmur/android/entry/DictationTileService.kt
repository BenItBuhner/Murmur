package app.murmur.android.entry

import android.app.PendingIntent
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
        when (val state = DictationController.state.value) {
            is DictationState.Idle -> tile.state = Tile.STATE_INACTIVE
            is DictationState.Listening -> {
                tile.state = Tile.STATE_ACTIVE
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    tile.subtitle = getString(R.string.tile_listening)
                }
            }
            else -> {
                tile.state = Tile.STATE_ACTIVE
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    tile.subtitle = getString(R.string.tile_transcribing)
                }
            }
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
