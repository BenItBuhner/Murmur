package app.murmur.android

import androidx.compose.runtime.saveable.SaverScope
import app.murmur.android.ui.NavEntry
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
    fun `a pushed screen wears a back arrow, the root wears the menu`() {
        val nav = Navigator(listOf(Route.HOME))
        assertTrue(nav.entry.topLevel)
        nav.open(Route.MODEL)
        assertEquals(NavEntry(Route.MODEL, 2, lateral = false), nav.entry)
        assertFalse(nav.entry.topLevel)
    }

    @Test
    fun `selecting a section from the drawer puts it on top of home so back leads home`() {
        val nav = Navigator(listOf(Route.HOME))
        nav.select(Route.DICTIONARY)
        assertEquals(listOf(Route.HOME, Route.DICTIONARY), nav.stack)
        assertTrue(nav.lateral)
        assertTrue(nav.entry.topLevel)
        assertEquals(Route.HOME, nav.previous)

        assertTrue(nav.back())
        assertEquals(listOf(Route.HOME), nav.stack)
        assertFalse(nav.lateral)
    }

    @Test
    fun `selecting another section replaces the one on top instead of piling up`() {
        val nav = Navigator(listOf(Route.HOME))
        nav.open(Route.MODEL)
        nav.select(Route.STYLE)
        assertEquals(listOf(Route.HOME, Route.STYLE), nav.stack)
        nav.select(Route.HISTORY)
        assertEquals(listOf(Route.HOME, Route.HISTORY), nav.stack)
        assertEquals(2, nav.depth)
    }

    @Test
    fun `selecting home from a section clears the stack sideways`() {
        val nav = Navigator(listOf(Route.HOME, Route.STYLE), lateral = true)
        nav.select(Route.HOME)
        assertEquals(listOf(Route.HOME), nav.stack)
        assertTrue(nav.lateral)
        assertFalse(nav.back())
    }

    @Test
    fun `selecting the section already showing does nothing`() {
        val nav = Navigator(listOf(Route.HOME, Route.STYLE))
        nav.select(Route.STYLE)
        assertEquals(listOf(Route.HOME, Route.STYLE), nav.stack)
        assertFalse(nav.lateral)
    }

    @Test
    fun `pushing after a lateral move drops the lateral flag`() {
        val nav = Navigator(listOf(Route.HOME))
        nav.select(Route.HISTORY)
        nav.open(Route.TRY_IT)
        assertEquals(listOf(Route.HOME, Route.HISTORY, Route.TRY_IT), nav.stack)
        assertFalse(nav.lateral)
        assertFalse(nav.entry.topLevel)
    }

    @Test
    fun `the saver round-trips the stack and the lateral flag`() {
        val scope = SaverScope { true }
        val saved = with(Navigator.Saver) { scope.save(Navigator(listOf(Route.HOME, Route.DICTIONARY), lateral = true)) }!!
        val restored = Navigator.Saver.restore(saved)!!
        assertEquals(listOf(Route.HOME, Route.DICTIONARY), restored.stack)
        assertTrue(restored.lateral)
    }

    @Test
    fun `the saver falls back to home for an empty or unknown stack`() {
        // mapSaver flattens the map into alternating keys and values.
        assertEquals(listOf(Route.HOME), Navigator.Saver.restore(listOf("stack", emptyList<String>()))?.stack)
        val restored = Navigator.Saver.restore(listOf("stack", listOf("NOT_A_ROUTE"), "lateral", false))!!
        assertEquals(listOf(Route.HOME), restored.stack)
        assertFalse(restored.lateral)
    }
}
