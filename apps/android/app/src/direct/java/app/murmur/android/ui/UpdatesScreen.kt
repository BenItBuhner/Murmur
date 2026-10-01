package app.murmur.android.ui

import androidx.compose.runtime.Composable
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.Screen

/** In-app updates from GitHub Releases (direct flavor); the controls are the shared [UpdatesSection]. */
@Composable
fun UpdatesScreen(store: SettingsStore, settings: MurmurSettings, nav: TopNav) {
    Screen(
        title = "Updates",
        description = "New versions come straight from GitHub Releases. Murmur fetches them for you; installing is always your tap.",
        nav = nav
    ) {
        UpdatesSection(store, settings)
    }
}
