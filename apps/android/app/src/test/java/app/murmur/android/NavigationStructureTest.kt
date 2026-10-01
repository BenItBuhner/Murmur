package app.murmur.android

import app.murmur.android.ui.NavEntry
import app.murmur.android.ui.Navigator
import app.murmur.android.ui.Route
import app.murmur.android.ui.drawerSections
import app.murmur.android.ui.settingsEntries
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The app's structure (ui/Sections.kt): five sections in the drawer, every settings page listed
 * on the Settings screen under the name it had, the account only at the drawer's foot, no
 * "Listening" row, and every screen the app has reachable from one of them.
 */
class NavigationStructureTest {

    private val drawer = drawerSections(settingsAttention = false)
    private val settings = settingsEntries(
        model = "Murmur's models · Normal", modelReady = true,
        language = "Auto-detect", button = "Shape, position, sounds and haptics", keyboard = "Shortcuts with a keyboard attached",
        appearance = "Follows the system · coral", permissions = "All 3 allowed", permissionsGranted = true,
        updates = "Murmur 0.6.3", updateReady = false
    )

    @Test
    fun `the drawer has exactly five sections, in order, with settings set apart`() {
        assertEquals(
            listOf("Home", "History", "Dictionary and snippets", "Style", "Settings"),
            drawer.map { it.label }
        )
        assertEquals(
            listOf(Route.HOME, Route.HISTORY, Route.DICTIONARY, Route.STYLE, Route.SETTINGS),
            drawer.map { it.route }
        )
        assertTrue(drawer.last().separated)
        assertTrue(drawer.none { it.group != null })
    }

    @Test
    fun `nothing is listed twice and the drawer has no Account or Listening item`() {
        val labels = drawer.map { it.label } + settings.map { it.label }
        assertEquals(labels.size, labels.toSet().size)
        val routes = drawer.map { it.route } + settings.map { it.route }
        assertEquals(routes.size, routes.toSet().size)
        assertFalse(labels.any { it.contains("Account") })
        assertFalse(labels.any { it.contains("Listening") })
        assertFalse(routes.contains(Route.ACCOUNT))
    }

    @Test
    fun `the Settings screen lists every former top-level setting under its old name, in two groups`() {
        assertEquals(
            listOf("Speech model", "Language", "Dictation button", "Keyboard", "Appearance", "Permissions", "Updates", "Try it"),
            settings.map { it.label }
        )
        assertEquals(listOf("Dictation", "App"), settings.mapNotNull { it.group })
        assertEquals(Route.MODEL, settings.first { it.group == "Dictation" }.route)
        assertEquals(Route.APPEARANCE, settings.first { it.group == "App" }.route)
    }

    @Test
    fun `every screen is reachable from the drawer, the Settings screen or the account row`() {
        val reachable = drawer.map { it.route }.toSet() + settings.map { it.route } + Route.ACCOUNT
        assertEquals(Route.entries.toSet(), reachable)
    }

    @Test
    fun `settings pages belong to the Settings section, sections to themselves`() {
        for (entry in settings) {
            assertTrue(entry.route.inSettings)
            assertEquals(Route.SETTINGS, entry.route.section)
        }
        for (section in drawer) {
            assertTrue(section.route.isSection)
            assertEquals(section.route, section.route.section)
        }
        assertTrue(Route.ACCOUNT.isSection)
    }

    @Test
    fun `the Settings item asks for attention when any of its pages does`() {
        assertTrue(drawerSections(settingsAttention = true).single { it.route == Route.SETTINGS }.attention)
        assertFalse(drawer.single { it.route == Route.SETTINGS }.attention)
        val unfinished = settingsEntries(
            model = "Not connected", modelReady = false, language = null, button = null, keyboard = null,
            appearance = null, permissions = "2 of 3 to allow", permissionsGranted = false, updates = "Version 0.7.0 is ready", updateReady = true
        )
        assertEquals(setOf(Route.MODEL, Route.PERMISSIONS, Route.UPDATES), unfinished.filter { it.attention }.map { it.route }.toSet())
        assertTrue(settings.none { it.attention })
    }

    @Test
    fun `every settings page is two taps from the drawer and back leads to Settings, then home`() {
        for (entry in settings) {
            val nav = Navigator(listOf(Route.HOME))
            nav.select(Route.SETTINGS)
            assertEquals(listOf(Route.HOME, Route.SETTINGS), nav.stack)
            assertTrue(nav.entry.topLevel)
            nav.open(entry.route)
            assertEquals(listOf(Route.HOME, Route.SETTINGS, entry.route), nav.stack)
            assertFalse(nav.entry.topLevel)
            assertEquals(Route.SETTINGS, nav.section)
            assertTrue(nav.back())
            assertEquals(Route.SETTINGS, nav.current)
            assertTrue(nav.entry.topLevel)
            assertTrue(nav.back())
            assertEquals(listOf(Route.HOME), nav.stack)
        }
    }

    @Test
    fun `a settings page asked for directly sits on Settings, so back leads there`() {
        val nav = Navigator(listOf(Route.HOME))
        nav.select(Route.MODEL)
        assertEquals(listOf(Route.HOME, Route.SETTINGS, Route.MODEL), nav.stack)
        assertTrue(nav.lateral)
        assertFalse(nav.entry.topLevel)
        assertEquals(Route.SETTINGS, nav.section)
        assertTrue(nav.back())
        assertEquals(listOf(Route.HOME, Route.SETTINGS), nav.stack)
    }

    @Test
    fun `the account is a section of its own, reached from the drawer's foot`() {
        val nav = Navigator(listOf(Route.HOME))
        nav.select(Route.ACCOUNT)
        assertEquals(listOf(Route.HOME, Route.ACCOUNT), nav.stack)
        assertTrue(nav.entry.topLevel)
        assertEquals(Route.ACCOUNT, nav.section)
    }

    @Test
    fun `a section keeps its state key whichever way it was reached`() {
        assertEquals(NavEntry(Route.STYLE, 2, lateral = true).key, NavEntry(Route.STYLE, 2, lateral = false).key)
        assertTrue(NavEntry(Route.STYLE, 2, lateral = false).key != NavEntry(Route.STYLE, 3, lateral = false).key)
    }
}
