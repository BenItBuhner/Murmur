package app.murmur.android.ui

import app.murmur.android.ui.components.Glyph

/*
 * The app's information architecture, in one place, as data: what the drawer lists and what the
 * Settings screen lists. The same five sections and the same names as the desktop sidebar; the
 * account is the drawer's foot, not an item in the list. Built here so the structure can be checked
 * without composing anything (NavigationStructureTest).
 */

/** One destination in the drawer. */
data class Section(
    val route: Route,
    val label: String,
    val glyph: Glyph,
    /** Starts a new group with this heading. */
    val group: String? = null,
    /** Set apart from the items above by space alone, without a heading. */
    val separated: Boolean = false,
    /** Something there needs the user (setup unfinished, an update ready). */
    val attention: Boolean = false
)

/** One row of the Settings screen: a page of the settings section and what it is currently set to. */
data class SettingsEntry(
    val route: Route,
    val label: String,
    val glyph: Glyph,
    /** The current value or a line of context, under the label. */
    val value: String? = null,
    /** Starts a new group with this heading. */
    val group: String? = null,
    val attention: Boolean = false
)

/** The drawer: home, history, the two personalization sections, then settings, set apart. */
fun drawerSections(settingsAttention: Boolean): List<Section> = listOf(
    Section(Route.HOME, "Home", Glyph.HOME),
    Section(Route.HISTORY, "History", Glyph.HISTORY),
    Section(Route.DICTIONARY, "Dictionary and snippets", Glyph.DICTIONARY),
    Section(Route.STYLE, "Style", Glyph.STYLE),
    Section(Route.SETTINGS, "Settings", Glyph.SETTINGS, separated = true, attention = settingsAttention)
)

/**
 * The Settings screen: how Murmur listens and types first, then the app itself. Every former
 * top-level setting is here under the name it had in the drawer.
 */
fun settingsEntries(
    model: String?,
    modelReady: Boolean,
    language: String?,
    button: String?,
    keyboard: String?,
    appearance: String?,
    permissions: String?,
    permissionsGranted: Boolean,
    updates: String?,
    updateReady: Boolean,
    tryIt: String? = "Dictate into a test pad"
): List<SettingsEntry> = listOf(
    SettingsEntry(Route.MODEL, "Speech model", Glyph.MODEL, model, group = "Dictation", attention = !modelReady),
    SettingsEntry(Route.LANGUAGE, "Language", Glyph.LANGUAGE, language),
    SettingsEntry(Route.BUTTON, "Dictation button", Glyph.BUTTON, button),
    SettingsEntry(Route.KEYBOARD, "Keyboard", Glyph.KEYBOARD, keyboard),
    SettingsEntry(Route.APPEARANCE, "Appearance", Glyph.APPEARANCE, appearance, group = "App"),
    SettingsEntry(Route.PERMISSIONS, "Permissions", Glyph.PERMISSIONS, permissions, attention = !permissionsGranted),
    SettingsEntry(Route.UPDATES, "Updates", Glyph.UPDATES, updates, attention = updateReady),
    SettingsEntry(Route.TRY_IT, "Try it", Glyph.TRY_IT, tryIt)
)
