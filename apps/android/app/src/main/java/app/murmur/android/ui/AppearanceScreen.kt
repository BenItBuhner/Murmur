package app.murmur.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.Screen

/**
 * Light/dark/system, wallpaper colours and the accent. The controls are the shared
 * [AppearanceSection]; the screen around them is the live preview.
 */
@Composable
fun AppearanceScreen(store: SettingsStore, settings: MurmurSettings, nav: TopNav) {
    Screen(
        title = "Appearance",
        description = "Light or dark, and where the palette comes from: your wallpaper on Android 12 and newer, or an accent of your choice.",
        nav = nav
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            AppearanceSection(store, settings)
        }
    }
}
