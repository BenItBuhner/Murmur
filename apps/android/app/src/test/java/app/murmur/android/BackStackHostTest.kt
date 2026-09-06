package app.murmur.android

import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import app.murmur.android.ui.BackStackHost
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Drives [BackStackHost] with the same back events the system sends during a predictive back
 * gesture, through the activity's OnBackPressedDispatcher, and checks what the user would see:
 * the screen below appears while the finger is down, letting go pops, backing out of the gesture
 * leaves everything as it was.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BackStackHostTest {

    @get:Rule
    val compose = createComposeRule()

    private val stack = mutableStateListOf("Home", "Detail")
    private lateinit var dispatcher: OnBackPressedDispatcher

    private fun show() {
        compose.setContent {
            dispatcher = LocalOnBackPressedDispatcherOwner.current!!.onBackPressedDispatcher
            BackStackHost(
                current = stack.last(),
                previous = stack.getOrNull(stack.size - 2),
                depth = { if (it == "Home") 0 else 1 },
                onBack = { stack.removeAt(stack.lastIndex) }
            ) { Text(it) }
        }
        compose.waitForIdle()
    }

    private fun event(progress: Float) =
        BackEventCompat(touchX = 40f + progress * 600f, touchY = 900f, progress = progress, swipeEdge = BackEventCompat.EDGE_LEFT)

    private fun swipeTo(progress: Float) {
        compose.runOnUiThread {
            dispatcher.dispatchOnBackStarted(event(0f))
            dispatcher.dispatchOnBackProgressed(event(progress / 2))
            dispatcher.dispatchOnBackProgressed(event(progress))
        }
        compose.waitForIdle()
    }

    @Test
    fun `while the finger is down the screen below is previewed and nothing is popped`() {
        show()
        compose.onNodeWithText("Detail").assertExists()
        compose.onNodeWithText("Home").assertDoesNotExist()

        swipeTo(0.4f)

        compose.onNodeWithText("Home").assertExists()
        compose.onNodeWithText("Detail").assertExists()
        assertEquals(listOf("Home", "Detail"), stack.toList())
    }

    @Test
    fun `letting go finishes the motion and pops`() {
        show()
        swipeTo(0.4f)

        compose.runOnUiThread { dispatcher.onBackPressed() }
        compose.waitForIdle()

        assertEquals(listOf("Home"), stack.toList())
        compose.onNodeWithText("Home").assertExists()
        compose.onNodeWithText("Detail").assertDoesNotExist()
    }

    @Test
    fun `backing out of the gesture leaves the stack and the screen as they were`() {
        show()
        swipeTo(0.4f)

        compose.runOnUiThread { dispatcher.dispatchOnBackCancelled() }
        compose.waitForIdle()

        assertEquals(listOf("Home", "Detail"), stack.toList())
        compose.onNodeWithText("Detail").assertExists()
        compose.onNodeWithText("Home").assertDoesNotExist()
    }

    @Test
    fun `a second gesture after a cancelled one works just the same`() {
        show()
        swipeTo(0.3f)
        compose.runOnUiThread { dispatcher.dispatchOnBackCancelled() }
        compose.waitForIdle()

        swipeTo(0.5f)
        compose.onNodeWithText("Home").assertExists()
        compose.runOnUiThread { dispatcher.onBackPressed() }
        compose.waitForIdle()

        assertEquals(listOf("Home"), stack.toList())
        compose.onNodeWithText("Detail").assertDoesNotExist()
    }

    @Test
    fun `a plain back press, with no gesture, pops as well`() {
        show()
        assertTrue(dispatcher.hasEnabledCallbacks())

        compose.runOnUiThread { dispatcher.onBackPressed() }
        compose.waitForIdle()

        assertEquals(listOf("Home"), stack.toList())
        compose.onNodeWithText("Detail").assertDoesNotExist()
    }

    @Test
    fun `at the root back is left to the system so it can animate the app away`() {
        stack.removeAt(stack.lastIndex)
        show()
        assertFalse(dispatcher.hasEnabledCallbacks())
    }
}
