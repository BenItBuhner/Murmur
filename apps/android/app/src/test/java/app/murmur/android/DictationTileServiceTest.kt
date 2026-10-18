package app.murmur.android

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import app.murmur.android.dictation.DictationState
import app.murmur.android.entry.DictationTileService
import app.murmur.android.entry.EntryActions
import app.murmur.android.entry.tileLook
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowService
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The "Dictate" Quick Settings tile: it mirrors the controller's state, and a tap fires the same
 * TOGGLE at the trampoline every other entry point uses — the tile itself never starts anything,
 * and a locked screen runs the tap only once the user is past it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], shadows = [ShadowQSTileService::class])
class DictationTileServiceTest {

    @Before
    fun setUp() {
        ShadowQSTileService.collapseCalls.clear()
        ShadowQSTileService.unlockRuns.clear()
        ShadowQSTileService.locked = false
    }

    @Test
    fun `the tile mirrors the controller's state`() {
        val context = RuntimeEnvironment.getApplication()
        assertEquals(Tile.STATE_INACTIVE to null, tileLook(context, DictationState.Idle))
        assertEquals(
            Tile.STATE_ACTIVE to context.getString(R.string.tile_listening),
            tileLook(context, DictationState.Listening(3, 0.5f))
        )
        assertEquals(
            Tile.STATE_ACTIVE to context.getString(R.string.tile_transcribing),
            tileLook(context, DictationState.Processing("Transcribing…"))
        )
        // A result on the pill keeps the tile active (it is still a dictation in flight).
        assertEquals(
            Tile.STATE_ACTIVE to context.getString(R.string.tile_transcribing),
            tileLook(context, DictationState.Success("Inserted"))
        )
    }

    @Test
    fun `a tap collapses into the trampoline with TOGGLE`() {
        val service = Robolectric.buildService(DictationTileService::class.java).create().get()
        service.onClick()
        assertEquals("one tap, one launch", 1, ShadowQSTileService.collapseCalls.size)
        val collapsed = ShadowQSTileService.collapseCalls.single() as PendingIntent
        val intent = Shadows.shadowOf(collapsed).savedIntent
        assertEquals(EntryActions.TOGGLE_DICTATION, intent.action)
        assertEquals("app.murmur.android.entry.DictationEntryActivity", intent.component?.className)
        assertEquals("app.murmur.android", intent.component?.packageName)
    }

    @Test
    fun `a tap on a locked screen waits for the unlock`() {
        val service = Robolectric.buildService(DictationTileService::class.java).create().get()
        ShadowQSTileService.locked = true
        service.onClick()
        assertTrue("nothing launched while locked", ShadowQSTileService.collapseCalls.isEmpty())
        assertEquals("the tap is held for the unlock", 1, ShadowQSTileService.unlockRuns.size)
        ShadowQSTileService.unlockRuns.single().run()
        assertEquals(1, ShadowQSTileService.collapseCalls.size)
    }

    @Test
    fun `the service survives a listening session with no tile to draw`() {
        // The system has not bound a tile; state changes must not take the service down.
        val controller = Robolectric.buildService(DictationTileService::class.java).create()
        val service = controller.get()
        service.onStartListening()
        service.onStopListening()
        service.onStartListening()
        service.onDestroy()
    }
}

/** Records what the tile asked the system to do; Robolectric has no Quick Settings to bind. */
@Implements(TileService::class)
class ShadowQSTileService : ShadowService() {
    companion object {
        val collapseCalls = CopyOnWriteArrayList<Any>()
        val unlockRuns = CopyOnWriteArrayList<Runnable>()
        var locked = false
    }

    @Implementation
    protected fun startActivityAndCollapse(pendingIntent: PendingIntent) {
        collapseCalls.add(pendingIntent)
    }

    @Implementation
    @Suppress("DEPRECATION")
    protected fun startActivityAndCollapse(intent: Intent) {
        collapseCalls.add(intent)
    }

    @Implementation
    protected fun isLocked(): Boolean = Companion.locked

    @Implementation
    protected fun unlockAndRun(runnable: Runnable) {
        unlockRuns.add(runnable)
    }
}
