package app.murmur.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import app.murmur.android.cloud.AccountMode
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.ui.components.FeatureRow
import app.murmur.android.ui.components.PageMargin
import app.murmur.android.ui.components.TextLink
import app.murmur.android.ui.components.Wordmark
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.clerkTheme
import com.clerk.api.Clerk
import com.clerk.ui.auth.AuthView

/**
 * The front door of a cloud build: Clerk's prebuilt sign-in/sign-up, dressed in the app's paper
 * and ink. Nobody reaches onboarding without an account unless the build is in `optional` mode.
 */
@Composable
fun AccountGateScreen(config: CloudConfig, onSkip: () -> Unit) {
    val ready by Clerk.isInitialized.collectAsState()
    val c = Murmur.colors
    val theme = clerkTheme()
    Column(
        Modifier
            .fillMaxSize()
            .background(c.paper)
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
            .imePadding()
            .padding(horizontal = PageMargin)
    ) {
        Spacer(Modifier.height(18.dp))
        Wordmark()
        Spacer(Modifier.height(40.dp))
        Text("Speak.", style = Murmur.type.displayLarge, color = c.ink)
        Text("It types.", style = Murmur.type.displayLarge.copy(fontStyle = FontStyle.Italic), color = c.inkSoft)
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
        if (!ready) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(16.dp), color = c.inkSoft, strokeWidth = 1.5.dp)
                Spacer(Modifier.width(12.dp))
                Text("Connecting to Murmur…", style = Murmur.type.bodySmall, color = c.inkSoft)
            }
        } else {
            AuthView(clerkTheme = theme)
        }
        if (config.accountMode == AccountMode.OPTIONAL) {
            Spacer(Modifier.height(24.dp))
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                TextLink("Continue without an account", onClick = onSkip, color = c.ink)
                Spacer(Modifier.height(6.dp))
                Text(
                    "Everything stays on this phone. You can sign in later from Account.",
                    style = Murmur.type.bodySmall,
                    color = c.inkMuted
                )
            }
        }
        Spacer(Modifier.height(32.dp))
    }
}
