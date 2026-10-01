package app.murmur.android

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.murmur.android.cloud.AccountMode
import app.murmur.android.cloud.CloudBoot
import app.murmur.android.cloud.CloudBootstrap
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.SyncStatus
import app.murmur.android.history.HistoryStore
import app.murmur.android.history.RecordingStore
import app.murmur.android.keyboard.KeyboardPresence
import app.murmur.android.keyboard.Keys
import app.murmur.android.overlay.OverlayEditor
import app.murmur.android.overlay.PillPresentation
import app.murmur.android.settings.Languages
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.SttPresets
import app.murmur.android.settings.ThemeMode
import app.murmur.android.ui.AccountGateScreen
import app.murmur.android.ui.AccountScreen
import app.murmur.android.ui.AppShell
import app.murmur.android.ui.AppearanceScreen
import app.murmur.android.ui.DictationButtonScreen
import app.murmur.android.ui.DictionaryScreen
import app.murmur.android.ui.DrawerRow
import app.murmur.android.ui.HistoryScreen
import app.murmur.android.ui.HomeScreen
import app.murmur.android.ui.KeyboardScreen
import app.murmur.android.ui.LanguageScreen
import app.murmur.android.ui.OnboardingScreen
import app.murmur.android.ui.PermissionsScreen
import app.murmur.android.ui.Route
import app.murmur.android.ui.SettingsScreen
import app.murmur.android.ui.SpeechModelScreen
import app.murmur.android.ui.StyleScreen
import app.murmur.android.ui.TryItScreen
import app.murmur.android.ui.UpdatesScreen
import app.murmur.android.ui.components.Glyph
import app.murmur.android.ui.components.GlyphIcon
import app.murmur.android.ui.drawerSections
import app.murmur.android.ui.rememberNavigator
import app.murmur.android.ui.rememberPermissionState
import app.murmur.android.ui.murmurStt
import app.murmur.android.ui.rememberInferenceView
import app.murmur.android.ui.settingsEntries
import app.murmur.android.ui.syncLabel
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.MurmurTheme
import app.murmur.android.ui.theme.supportsDynamicColor
import app.murmur.android.update.Updates
import com.clerk.api.Clerk
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class MainActivity : ComponentActivity() {
    /** A screen another part of the app asked for (the pill's "own model" chip); consumed once shown. */
    private val requestedRoute = MutableStateFlow<Route?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestedRoute.value = routeFrom(intent)
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
                    Root(config, store, settings, requestedRoute, onRouteShown = { requestedRoute.value = null })
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        routeFrom(intent)?.let { requestedRoute.value = it }
    }

    override fun onResume() {
        super.onResume()
        Updates.get(this).onAppVisible()
    }

    override fun onPause() {
        Updates.get(this).onAppHidden()
        super.onPause()
    }

    override fun onStop() {
        // Never leave the full-screen drag surface behind when the user leaves the app.
        OverlayEditor.stop()
        // Leaving normally is not a start-up crash: the cloud boot guard stands down.
        CloudBootstrap.onUiStopped()
        super.onStop()
    }

    companion object {
        private const val EXTRA_ROUTE = "app.murmur.android.ROUTE"

        /** An intent that brings Murmur to the front on [route] (the activity is a single task). */
        fun intentFor(context: Context, route: Route): Intent =
            Intent(context, MainActivity::class.java).putExtra(EXTRA_ROUTE, route.name)

        fun routeFrom(intent: Intent?): Route? =
            intent?.getStringExtra(EXTRA_ROUTE)?.let { name -> Route.entries.firstOrNull { it.name == name } }
    }
}

/**
 * Cloud builds: account gate -> onboarding -> settings. Local builds: onboarding -> settings.
 * A device that signed in before keeps working from its local mirror when Clerk cannot be reached.
 * A cloud build whose cloud failed to come up ([CloudBoot.Failed]) runs like a local build, with
 * the Account screen explaining; Clerk is not touched at all then, since its classes may be the
 * very thing that failed.
 */
@Composable
private fun Root(
    config: CloudConfig,
    store: SettingsStore,
    settings: MurmurSettings,
    requestedRoute: StateFlow<Route?>,
    onRouteShown: () -> Unit
) {
    val cloud by CloudBootstrap.state.collectAsState()
    val cloudUsable = config.enabled && cloud.usable
    val clerkReady by (if (cloudUsable) Clerk.isInitialized else remember { MutableStateFlow(true) }).collectAsState()
    val clerkUser by (if (cloudUsable) Clerk.userFlow else remember { MutableStateFlow(null) }).collectAsState()
    val syncStatus = CloudSync.get()?.status?.collectAsState()?.value
    val signedIn = cloudUsable && clerkUser != null
    val firstName = clerkUser?.firstName ?: syncStatus?.user?.name?.substringBefore(' ')

    val accountWanted = cloudUsable && (
        config.accountMode == AccountMode.REQUIRED ||
            (config.accountMode == AccountMode.OPTIONAL && !settings.accountSkipped)
        )
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

    Main(config, cloud, store, settings, signedIn, firstName, syncStatus, requestedRoute, onRouteShown)
}

/**
 * The app proper: the drawer of sections down the left, and the current section in front of it.
 * The drawer's foot mirrors the desktop sidebar: the account, then the version. The state of the
 * button lives on the home screen, not in the drawer.
 */
@Composable
private fun Main(
    config: CloudConfig,
    cloud: CloudBoot,
    store: SettingsStore,
    settings: MurmurSettings,
    signedIn: Boolean,
    firstName: String?,
    syncStatus: SyncStatus?,
    requestedRoute: StateFlow<Route?>,
    onRouteShown: () -> Unit
) {
    val c = Murmur.colors
    val context = LocalContext.current
    val navigator = rememberNavigator()
    val requested by requestedRoute.collectAsState()
    LaunchedEffect(requested) {
        requested?.let {
            navigator.select(it)
            onRouteShown()
        }
    }
    val permissions = rememberPermissionState()
    val readyVersion by Updates.get(context).readyVersion.collectAsState()
    val inference = rememberInferenceView(settings)
    val modelReady = inference.sttReady
    // A keyboard attached or detached recreates the activity; read the device again each time.
    val presence = remember(context) { KeyboardPresence.get(context) }
    val configuration = LocalConfiguration.current
    LaunchedEffect(configuration) { presence.refresh(configuration) }
    val posture by presence.posture.collectAsState()
    val desktopPill = PillPresentation.resolve(settings.keyboard, posture) is PillPresentation.Desktop
    val readyHint = when {
        posture.hardwareKeyboard && settings.keyboard.shortcuts && settings.keyboard.pushToTalk.isNotEmpty() ->
            "hold ${Keys.chordLabel(settings.keyboard.pushToTalk, settings.keyboard.sideSensitive)} to dictate"
        desktopPill -> "tap the pill to dictate"
        else -> "tap the button beside your keyboard"
    }
    val cloudDown = config.enabled && !cloud.usable
    val updateReady = readyVersion != null
    val sections = drawerSections(settingsAttention = !modelReady || !permissions.allGranted || updateReady)
    val entries = settingsEntries(
        model = when {
            inference.routing.murmurStt -> "Murmur's models · ${settings.sttSpeed.label}"
            !modelReady -> "Not connected"
            else -> listOf(SttPresets.find(settings.sttPresetId).name, settings.sttModel).filter { it.isNotBlank() }.joinToString(" · ")
        },
        modelReady = modelReady,
        language = Languages.label(settings.language),
        button = "Shape, position, sounds and haptics",
        keyboard = when {
            posture.hardwareKeyboard && settings.keyboard.shortcuts && settings.keyboard.pushToTalk.isNotEmpty() ->
                "Hold ${Keys.chordLabel(settings.keyboard.pushToTalk, settings.keyboard.sideSensitive)} to dictate"
            else -> "Shortcuts with a keyboard attached"
        },
        appearance = listOfNotNull(
            when (settings.themeMode) {
                ThemeMode.SYSTEM -> "Follows the system"
                ThemeMode.LIGHT -> "Light"
                ThemeMode.DARK -> "Dark"
            },
            if (settings.dynamicColor && supportsDynamicColor) "wallpaper colours" else settings.accent.label.lowercase()
        ).joinToString(" · "),
        permissions = if (permissions.allGranted) "All ${permissions.total} allowed" else "${permissions.total - permissions.granted} of ${permissions.total} to allow",
        permissionsGranted = permissions.allGranted,
        updates = if (updateReady) "Version ${readyVersion ?: ""} is ready".trim() else "Murmur ${BuildConfig.VERSION_NAME}",
        updateReady = updateReady
    )

    AppShell(
        navigator = navigator,
        sections = sections,
        footer = { select ->
            if (config.enabled) {
                val name = syncStatus?.user?.name?.takeIf { it.isNotBlank() } ?: firstName
                val email = syncStatus?.user?.email
                DrawerRow(
                    label = when {
                        cloudDown -> "Not connected"
                        signedIn -> name ?: email ?: "Your account"
                        else -> "Not signed in"
                    },
                    hint = when {
                        cloudDown -> "couldn't connect to Murmur's server"
                        signedIn && syncStatus != null ->
                            listOfNotNull(if (name != null) email else null, syncLabel(syncStatus)).joinToString(" · ")
                        else -> "sign in to sync your dictionary and style"
                    },
                    dot = if (cloudDown) c.ember else null,
                    leading = { Avatar((name ?: email ?: "?").first().uppercaseChar(), signedIn) },
                    onClick = { select(Route.ACCOUNT) },
                    modifier = Modifier.testTag("drawer-account")
                )
                Spacer(Modifier.height(12.dp))
            }
            Text(
                "Murmur ${BuildConfig.VERSION_NAME}",
                style = Murmur.type.labelSmall,
                color = c.inkMuted,
                modifier = Modifier.padding(start = 14.dp, bottom = 4.dp)
            )
        }
    ) { entry, nav ->
        when (entry.route) {
            Route.HOME -> HomeScreen(config, settings, signedIn, firstName, syncStatus, nav, onOpen = navigator::open, howTo = readyHint)
            Route.SETTINGS -> SettingsScreen(entries, nav, onOpen = navigator::open)
            Route.HISTORY -> HistoryScreen(HistoryStore.get(context), store, RecordingStore.get(context), nav, syncStatus)
            Route.BUTTON -> DictationButtonScreen(store, settings, nav)
            Route.KEYBOARD -> KeyboardScreen(store, settings, nav)
            Route.MODEL -> SpeechModelScreen(store, settings, nav)
            Route.LANGUAGE -> LanguageScreen(store, settings, signedIn, nav)
            Route.STYLE -> StyleScreen(store, settings, nav)
            Route.DICTIONARY -> DictionaryScreen(store, synced = signedIn, nav = nav)
            Route.APPEARANCE -> AppearanceScreen(store, settings, nav)
            Route.PERMISSIONS -> PermissionsScreen(nav)
            Route.UPDATES -> UpdatesScreen(store, settings, nav)
            Route.TRY_IT -> TryItScreen(store, settings, nav)
            Route.ACCOUNT -> AccountScreen(
                config, cloud, store, nav,
                onSignIn = { store.update { it.copy(accountSkipped = false) } }
            )
        }
    }
}

/** The account's initial in a small disc; hollow when nobody is signed in. */
@Composable
private fun Avatar(initial: Char, signedIn: Boolean) {
    val c = Murmur.colors
    Box(
        Modifier
            .size(28.dp)
            .clip(CircleShape)
            .background(if (signedIn) c.ember else c.paperRaised),
        contentAlignment = Alignment.Center
    ) {
        if (signedIn) {
            Text(initial.toString(), style = Murmur.type.labelSmall, color = c.onEmber)
        } else {
            GlyphIcon(Glyph.ACCOUNT, c.inkSoft, size = 16.dp)
        }
    }
}
