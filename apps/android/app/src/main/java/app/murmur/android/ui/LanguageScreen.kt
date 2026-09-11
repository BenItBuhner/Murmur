package app.murmur.android.ui

import androidx.compose.runtime.Composable
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.Screen

/** The dictation language: one setting for the speech model and the formatting model, synced with the account. */
@Composable
fun LanguageScreen(store: SettingsStore, settings: MurmurSettings, synced: Boolean, nav: TopNav) {
    Screen(
        title = "Language",
        description = if (synced) {
            "Steers both the speech model and the formatting model. Follows your account to every device."
        } else {
            "Steers both the speech model and the formatting model."
        },
        nav = nav
    ) {
        Group("Recognition") {
            LanguagePicker(store, settings)
        }
    }
}
