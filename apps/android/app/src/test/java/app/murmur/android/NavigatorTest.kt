package app.murmur.android

import androidx.compose.runtime.saveable.SaverScope
import app.murmur.android.ui.Navigator
import app.murmur.android.ui.Route
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigatorTest {

    @Test
    fun `at the root there is nothing to go back to`() {
        val nav = Navigator(listOf(Route.HOME))
        assertEquals(Route.HOME, nav.current)
        assertEquals(1, nav.depth)
        assertNull(nav.previous)
        assertFalse(nav.back())
        assertEquals(listOf(Route.HOME), nav.stack)
    }

    @Test
    fun `opening a screen stacks it on top and remembers what is underneath`() {
        val nav = Navigator(listOf(Route.HOME))
        nav.open(Route.STYLE)
        assertEquals(Route.STYLE, nav.current)
        assertEquals(Route.HOME, nav.previous)
        assertEquals(2, nav.depth)
        assertTrue(nav.back())
        assertEquals(Route.HOME, nav.current)
        assertNull(nav.previous)
    }

    @Test
    fun `opening the screen already on top does nothing`() {
        val nav = Navigator(listOf(Route.HOME, Route.STYLE))
        nav.open(Route.STYLE)
        assertEquals(listOf(Route.HOME, Route.STYLE), nav.stack)
    }

    @Test
    fun `the saver round-trips the stack and falls back to home when it is empty`() {
        val saved = listOf("HOME", "DICTIONARY")
        val scope = SaverScope { true }
        assertEquals(saved, with(Navigator.Saver) { scope.save(Navigator(listOf(Route.HOME, Route.DICTIONARY))) })
        assertEquals(listOf(Route.HOME, Route.DICTIONARY), Navigator.Saver.restore(saved)?.stack)
        assertEquals(listOf(Route.HOME), Navigator.Saver.restore(emptyList<String>())?.stack)
    }
}
