package app.murmur.android.ui

import androidx.compose.runtime.Composable
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.Notice
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SectionGap

/**
 * Light/dark/system, wallpaper colours and the accent. The controls are the shared
 * [AppearanceSection]; the screen around them is the live preview. The button's own look is set
 * on the Dictation button screen, and a line at the end says so.
 */
@Composable
fun AppearanceScreen(store: SettingsStore, settings: MurmurSettings, nav: TopNav) {
    Screen(
        title = "Appearance",
        description = "Light or dark, and where the palette comes from: your wallpaper on Android 12 and newer, or an accent of your choice.",
        nav = nav
    ) {
        AppearanceSection(store, settings)
        SectionGap()
        Notice("Shape and shadow for the button itself are under Dictation button.")
    }
}
