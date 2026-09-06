package app.murmur.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import app.murmur.android.cloud.AccountMode
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.SyncStatus
import app.murmur.android.overlay.OverlayEditor
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.ThemeMode
import app.murmur.android.ui.AccountGateScreen
import app.murmur.android.ui.AccountScreen
import app.murmur.android.ui.AppearanceScreen
import app.murmur.android.ui.DictationButtonScreen
import app.murmur.android.ui.DictionaryScreen
import app.murmur.android.ui.HomeScreen
import app.murmur.android.ui.LanguageScreen
import app.murmur.android.ui.NavHost
import app.murmur.android.ui.OnboardingScreen
import app.murmur.android.ui.PermissionsScreen
import app.murmur.android.ui.Route
import app.murmur.android.ui.SpeechModelScreen
import app.murmur.android.ui.StyleScreen
import app.murmur.android.ui.TryItScreen
import app.murmur.android.ui.UpdatesScreen
import app.murmur.android.ui.rememberNavigator
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.MurmurTheme
import app.murmur.android.update.UpdateManager
import com.clerk.api.Clerk
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = SettingsStore.get(this)
        // A forced light/dark choice picks the window theme too, so the frame before Compose draws
        // (and the window background behind the keyboard) already has the right brightness.
        when (store.get().themeMode) {
            ThemeMode.LIGHT -> setTheme(R.style.Theme_Murmur_Light)
            ThemeMode.DARK -> setTheme(R.style.Theme_Murmur_Dark)
            ThemeMode.SYSTEM -> Unit
        }
        enableEdgeToEdge()
        val config = (application as? MurmurApplication)?.cloudConfig ?: CloudConfig.OFF
        setContent {
            val settings by store.flow.collectAsState()
            MurmurTheme(settings) {
                Box(Modifier.fillMaxSize().background(Murmur.colors.paper)) {
                    Root(config, store, settings)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        val updates = UpdateManager.get(this)
        updates.foreground = true
        updates.onAppVisible()
    }

    override fun onPause() {
        UpdateManager.get(this).foreground = false
        super.onPause()
    }

    override fun onStop() {
        // Never leave the full-screen drag surface behind when the user leaves the app.
        OverlayEditor.stop()
        super.onStop()
    }
}

/**
 * Cloud builds: account gate -> onboarding -> settings. Local builds: onboarding -> settings.
 * A device that signed in before keeps working from its local mirror when Clerk cannot be reached.
 */
@Composable
private fun Root(config: CloudConfig, store: SettingsStore, settings: MurmurSettings) {
    val clerkReady by (if (config.enabled) Clerk.isInitialized else remember { MutableStateFlow(true) }).collectAsState()
    val clerkUser by (if (config.enabled) Clerk.userFlow else remember { MutableStateFlow(null) }).collectAsState()
    val syncStatus = CloudSync.get()?.status?.collectAsState()?.value
    val signedIn = config.enabled && clerkUser != null
    val firstName = clerkUser?.firstName ?: syncStatus?.user?.name?.substringBefore(' ')

    val accountWanted = config.accountMode == AccountMode.REQUIRED ||
        (config.accountMode == AccountMode.OPTIONAL && !settings.accountSkipped)
    if (accountWanted && !signedIn) {
        val offlineFallback = clerkReady && settings.lastSignedInUserId.isNotEmpty()
        if (!offlineFallback) {
            AccountGateScreen(config, onSkip = { store.update { it.copy(accountSkipped = true) } })
            return
        }
    }

    if (!settings.onboardingComplete) {
        OnboardingScreen(
            store = store,
            signedIn = signedIn,
            accountOnboarded = syncStatus?.user?.onboardingCompletedAt != null,
            firstName = firstName,
            onFinish = {
                store.update { it.copy(onboardingComplete = true) }
                CloudSync.get()?.completeOnboarding()
            }
        )
        return
    }

    Settings(config, store, settings, signedIn, firstName, syncStatus)
}

@Composable
private fun Settings(
    config: CloudConfig,
    store: SettingsStore,
    settings: MurmurSettings,
    signedIn: Boolean,
    firstName: String?,
    syncStatus: SyncStatus?
) {
    val navigator = rememberNavigator()
    NavHost(navigator) { route ->
        when (route) {
            Route.HOME -> HomeScreen(config, settings, signedIn, firstName, syncStatus, onOpen = navigator::open)
            Route.BUTTON -> DictationButtonScreen(store, settings, onBack = { navigator.back() })
            Route.MODEL -> SpeechModelScreen(store, settings, onBack = { navigator.back() })
            Route.LANGUAGE -> LanguageScreen(store, settings, signedIn, onBack = { navigator.back() })
            Route.STYLE -> StyleScreen(store, settings, onBack = { navigator.back() })
            Route.DICTIONARY -> DictionaryScreen(store, synced = signedIn, onBack = { navigator.back() })
            Route.APPEARANCE -> AppearanceScreen(store, settings, onBack = { navigator.back() })
            Route.PERMISSIONS -> PermissionsScreen(onBack = { navigator.back() })
            Route.UPDATES -> UpdatesScreen(store, settings, onBack = { navigator.back() })
            Route.TRY_IT -> TryItScreen(store, settings, onBack = { navigator.back() })
            Route.ACCOUNT -> AccountScreen(
                config, store,
                onBack = { navigator.back() },
                onSignIn = { store.update { it.copy(accountSkipped = false) } }
            )
        }
    }
}
