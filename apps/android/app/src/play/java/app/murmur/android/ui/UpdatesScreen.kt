package app.murmur.android.ui

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.murmur.android.BuildConfig
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.update.PlayListing

/**
 * Updates in the Google Play flavor: there is no updater in this build, Play keeps it current.
 * The screen says so and points at the listing; same route and drawer entry as the direct flavor.
 */
@Composable
@Suppress("UNUSED_PARAMETER")
fun UpdatesScreen(store: SettingsStore, settings: MurmurSettings, nav: TopNav) {
    val context = LocalContext.current
    val c = Murmur.colors
    Screen(
        title = "Updates",
        description = "This copy of Murmur comes from Google Play, which keeps it up to date.",
        nav = nav
    ) {
        Group("This install") {
            Text("Murmur ${BuildConfig.VERSION_NAME}", style = Murmur.type.title, color = c.ink)
            Spacer(Modifier.height(4.dp))
            Text(
                "New versions arrive through Google Play like your other apps. Turn on auto-update there to get them as soon as they are out.",
                style = Murmur.type.bodySmall,
                color = c.inkSoft
            )
            Spacer(Modifier.height(16.dp))
            SecondaryButton("Open Google Play", compact = true, onClick = { PlayListing.open(context) })
        }
    }
}
