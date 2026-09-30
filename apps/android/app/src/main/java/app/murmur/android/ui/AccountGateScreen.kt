package app.murmur.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.murmur.android.cloud.AccountMode
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudBootstrap
import app.murmur.android.ui.components.FeatureRow
import app.murmur.android.ui.components.PageMargin
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.TextLink
import app.murmur.android.ui.components.Wordmark
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.clerkTheme
import com.clerk.api.Clerk
import com.clerk.ui.auth.AuthView
import kotlinx.coroutines.delay

/** How long the gate waits for Clerk to report ready before it offers a way past the spinner. */
const val ACCOUNT_GATE_TIMEOUT_MS = 20_000L

/** The sign-in form never gets less than this; on a short screen the page scrolls to show it. */
private val MinFormHeight = 360.dp

/** The intro above the form and the skip link below it, roughly, so the form can take the rest. */
private val IntroHeight = 150.dp
private val SkipHeight = 84.dp

/**
 * The front door of a cloud build: Clerk's prebuilt sign-in/sign-up, dressed in the app's paper
 * and ink. Nobody reaches onboarding without an account unless the build is in `optional` mode,
 * or the sign-in service cannot be reached: then the app is still usable without an account.
 */
@Composable
fun AccountGateScreen(config: CloudConfig, onSkip: () -> Unit) {
    val ready by Clerk.isInitialized.collectAsState()
    val error by Clerk.initializationError.collectAsState()
    AccountGate(
        config = config,
        ready = ready,
        error = error?.let { CloudBootstrap.describe(it) },
        onRetry = { runCatching { Clerk.reinitialize() } },
        onSkip = onSkip
    ) {
        AuthView(clerkTheme = clerkTheme(), isDismissible = false)
    }
}

/**
 * The gate's layout, with the sign-in form injected so a test can stand in for Clerk's.
 *
 * Clerk's form is a Material3 Scaffold: it fills whatever height it is given, and inside a
 * scrolling column that height is unbounded, which Compose refuses at measure time
 * (`Size(w x 2147483647) is out of range`), taking the app down the moment Clerk is ready. So the
 * form gets a fixed height: what is left of the window below the intro and above the skip link,
 * never less than [MinFormHeight]. On a tall phone everything fits without scrolling; on a short
 * one the page scrolls, and the keyboard scrolls the focused field into view. The gate lays out in
 * any parent, bounded (the activity's window) or not (a scroller): AccountGateWithClerkTest
 * composes the real form in both.
 *
 * @param ready Clerk has its environment and client; the form can be shown.
 * @param error why Clerk could not get ready, when it gave up; shown with a retry.
 * @param readyTimeoutMs after this long without [ready] the spinner turns into the retry state.
 */
@Composable
fun AccountGate(
    config: CloudConfig,
    ready: Boolean,
    error: String?,
    onRetry: () -> Unit,
    onSkip: () -> Unit,
    readyTimeoutMs: Long = ACCOUNT_GATE_TIMEOUT_MS,
    signIn: @Composable () -> Unit
) {
    val c = Murmur.colors
    var timedOut by remember { mutableStateOf(false) }
    LaunchedEffect(ready, error) {
        timedOut = false
        if (!ready && error == null) {
            delay(readyTimeoutMs)
            timedOut = true
        }
    }
    val stuck = !ready && (error != null || timedOut)
    val formHeight = signInFormHeight(skip = config.accountMode == AccountMode.OPTIONAL)
    val scrollState = rememberScrollState()

    // The gate scrolls itself only when its parent bounds its height (the window, normally). In a
    // parent that does not, another scroller is already at work, and Compose refuses a vertical
    // scroller measured with no height bound; so the page is left to the parent. Either way the form
    // keeps its fixed height, so Clerk's Scaffold is never measured against infinity.
    BoxWithConstraints(Modifier.fillMaxSize().background(c.paper)) {
        val scroll = if (constraints.hasBoundedHeight) Modifier.verticalScroll(scrollState) else Modifier
        Column(
            Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .then(scroll)
                .navigationBarsPadding()
                .imePadding()
                .padding(horizontal = PageMargin)
        ) {
            GateContent(config, ready, stuck, error, formHeight, onRetry, onSkip, signIn)
        }
    }
}

/** The page itself: intro, then the form, the spinner or the trouble state, then the way past it. */
@Composable
private fun ColumnScope.GateContent(
    config: CloudConfig,
    ready: Boolean,
    stuck: Boolean,
    error: String?,
    formHeight: Dp,
    onRetry: () -> Unit,
    onSkip: () -> Unit,
    signIn: @Composable () -> Unit
) {
    val c = Murmur.colors
    Spacer(Modifier.height(18.dp))
    Wordmark()
    Spacer(Modifier.height(if (ready) 20.dp else 40.dp))
    Text("Speak.", style = Murmur.type.displayLarge, color = c.ink)
    Text("It types.", style = Murmur.type.displayLarge.copy(fontStyle = FontStyle.Italic), color = c.inkSoft)
    if (!ready) {
        Spacer(Modifier.height(20.dp))
        Text(
            "Tap the button beside your keyboard, say what you mean, and finished text lands where your cursor is. " +
                "Your account keeps one dictionary and one set of style rules across your phone and your desktop.",
            style = Murmur.type.body,
            color = c.inkSoft
        )
        Spacer(Modifier.height(20.dp))
        Column {
            FeatureRow("One dictionary for every device you sign in on")
            FeatureRow("Style and tone preferences follow you")
            FeatureRow("Speech-model keys never leave this phone")
        }
        Spacer(Modifier.height(32.dp))
    }
    when {
        ready -> Box(
            Modifier
                .fillMaxWidth()
                .height(formHeight)
                .testTag("account-gate-form")
        ) { signIn() }
        stuck -> CloudTrouble(
            detail = error,
            onRetry = onRetry,
            modifier = Modifier.testTag("account-gate-trouble")
        )
        else -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("account-gate-connecting")) {
            CircularProgressIndicator(Modifier.size(16.dp), color = c.inkSoft, strokeWidth = 1.5.dp)
            Spacer(Modifier.width(12.dp))
            Text("Connecting to Murmur…", style = Murmur.type.bodySmall, color = c.inkSoft)
        }
    }
    // Skipping is the build's choice in optional mode, and everyone's way out when the sign-in
    // service is unreachable: the app must keep working without it.
    if (config.accountMode == AccountMode.OPTIONAL || stuck) {
        Spacer(Modifier.height(24.dp))
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            TextLink("Continue without an account", onClick = onSkip, color = c.ink)
            Spacer(Modifier.height(6.dp))
            Text(
                if (stuck) "Everything stays on this phone. You can sign in later from Account, once Murmur's server can be reached."
                else "Everything stays on this phone. You can sign in later from Account.",
                style = Murmur.type.bodySmall,
                color = c.inkMuted
            )
        }
    }
    Spacer(Modifier.height(32.dp))
}

/** The height the sign-in form gets: the window minus the system bars, the intro and the skip link, at least [MinFormHeight]. */
@Composable
private fun signInFormHeight(skip: Boolean): Dp {
    val density = LocalDensity.current
    val window = with(density) { LocalWindowInfo.current.containerSize.height.toDp() }
    val bars = WindowInsets.systemBars.asPaddingValues()
    val available = window - bars.calculateTopPadding() - bars.calculateBottomPadding() - IntroHeight - (if (skip) SkipHeight else 32.dp)
    return if (available > MinFormHeight) available else MinFormHeight
}

/**
 * The account service cannot be reached or failed to come up: what happened, a retry, and (from
 * the caller) the way to carry on without it. Shared by the gate and the Account screen.
 */
@Composable
fun CloudTrouble(detail: String?, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val c = Murmur.colors
    Column(modifier.fillMaxWidth()) {
        Text("Couldn't connect to Murmur's server", style = Murmur.type.title, color = c.ink)
        Spacer(Modifier.height(6.dp))
        Text(
            "Sign-in and sync are unavailable right now. Your own speech provider and everything on this phone keep working.",
            style = Murmur.type.bodySmall,
            color = c.inkSoft
        )
        if (!detail.isNullOrBlank()) {
            Spacer(Modifier.height(6.dp))
            Text(detail, style = Murmur.type.labelSmall, color = c.inkMuted)
        }
        Spacer(Modifier.height(14.dp))
        SecondaryButton("Try again", onClick = onRetry)
    }
}
