package app.murmur.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.Screen

/** In-app updates from GitHub Releases; the controls are the shared [UpdatesSection]. */
@Composable
fun UpdatesScreen(store: SettingsStore, settings: MurmurSettings, onBack: () -> Unit) {
    Screen(
        title = "Updates",
        description = "New versions come straight from GitHub Releases and install once nothing is being dictated.",
        onBack = onBack
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            UpdatesSection(store, settings)
        }
    }
}
