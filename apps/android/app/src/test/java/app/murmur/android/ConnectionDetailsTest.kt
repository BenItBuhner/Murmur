package app.murmur.android

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudDiagnostics
import app.murmur.android.cloud.DeviceDto
import app.murmur.android.cloud.SyncPhase
import app.murmur.android.cloud.SyncStatus
import app.murmur.android.cloud.UserDto
import app.murmur.android.inference.InferenceRouting
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.AccountContent
import app.murmur.android.ui.AccountTroubleScreen
import app.murmur.android.ui.InferenceView
import app.murmur.android.ui.LocalInferenceView
import app.murmur.android.ui.TopNav
import app.murmur.android.ui.syncLabel
import app.murmur.android.ui.theme.MurmurTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.io.FileOutputStream

/**
 * The Account screen's "Connection details" row: on the signed-in screen and on the one shown when
 * the cloud could not come up, one line of where things stand and a Copy that puts the whole
 * report on the clipboard, so the next failure can be read off the phone. And the plan card's
 * words before the account status has arrived: Murmur's models being checked, no plan, no badge.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConnectionDetailsTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private lateinit var context: Context
    private lateinit var store: SettingsStore
    private val config = CloudConfig.resolve("https://a.convex.cloud", "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k", "")

    private fun view(status: app.murmur.android.cloud.InferenceStatusDto?) = InferenceView(
        cloudEnabled = true, managedAvailable = true,
        routing = InferenceRouting(InferenceSource.MURMUR, InferenceSource.MURMUR),
        signedIn = true, status = status, plan = status?.plan ?: "free", planState = status?.planState ?: "free",
        trialDaysLeft = 0, sttReady = true, llmReady = true, billingEnabled = status?.billingEnabled ?: true
    )

    private fun status(phase: SyncPhase, pending: Int, error: String?) = SyncStatus(
        phase = phase, signedIn = true, authenticated = phase != SyncPhase.ERROR, connected = phase == SyncPhase.SYNCED, pendingOps = pending,
        user = UserDto(id = "u1", clerkId = "user_1", email = "ann@example.com", name = "Ann Example"),
        devices = if (phase == SyncPhase.SYNCED) listOf(DeviceDto("d1", "phone", "Pixel 9", "android", "0.6.5", 1.0, 1.0)) else emptyList(),
        error = error
    )

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        store = SettingsStore(context)
        CloudDiagnostics.reset()
    }

    private fun clipboardText(): String {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        return clipboard.primaryClip?.getItemAt(0)?.text?.toString().orEmpty()
    }

    /** Draws the screen into `build/reports/pill-screenshots/account/<name>.png`, as the parity screenshot tests do. */
    private fun snap(name: String) {
        val dir = System.getProperty("murmur.screenshotDir")?.takeIf { it.isNotBlank() }?.let { File(it, "account") } ?: return
        dir.mkdirs()
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        compose.runOnUiThread { view.draw(Canvas(bitmap)) }
        FileOutputStream(File(dir, "$name.png")).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun `the signed-in screen carries the row, and Copy puts the report on the clipboard`() {
        CloudDiagnostics.boot("ready (optional, https://a.convex.cloud)")
        CloudDiagnostics.socket("connected")
        CloudDiagnostics.auth("authenticated")
        CloudDiagnostics.tokenFetch("convex", skipCache = true, startedAt = System.currentTimeMillis() - 120, ok = true, detail = null)
        CloudDiagnostics.sync("synced", 0, null)
        compose.setContent {
            CompositionLocalProvider(LocalInferenceView provides view(app.murmur.android.cloud.InferenceStatusDto(available = true, plan = "unlimited", planState = "unlimited", billingEnabled = false))) {
                MurmurTheme(store.get().copy(dynamicColor = false)) {
                    AccountContent(
                        config = config, status = status(SyncPhase.SYNCED, 0, null), name = "Ann Example", email = "ann@example.com",
                        settings = store.get(), nav = TopNav.Back {}, onSyncNow = {}, onSignOut = {}
                    )
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithText("Connection details").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("WebSocket connected · authenticated · 0 pending · token ok 0s ago").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("connection-details-copy").performScrollTo().performClick()
        compose.waitForIdle()
        val report = clipboardText()
        assertTrue(report, report.contains("Convex WebSocket: connected"))
        assertTrue(report, report.contains("Convex auth: authenticated"))
        assertTrue(report, report.contains("Boot: ready (optional, https://a.convex.cloud)"))
        assertTrue(report, report.contains("Last token fetch: ok"))
        assertTrue(report, report.contains("Recent events"))
        compose.onNodeWithText("Copied").assertIsDisplayed()
        // Show puts the same text on the screen, selectable.
        compose.onNodeWithText("Show").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("connection-details-report").performScrollTo().assertIsDisplayed()
        snap("account-connection-details-shown")
        // With the status here and billing off, the card names the server's list, not a plan: the title and its badge.
        assertEquals(2, compose.onAllNodesWithTextContaining("Unlimited").fetchSemanticsNodesCount())
        assertEquals(0, compose.onAllNodesWithTextContaining("Free").fetchSemanticsNodesCount())
    }

    @Test
    fun `the sync label keeps a reason to one short line, the whole of it being in the report`() {
        val long = status(
            SyncPhase.ERROR, 3,
            "[Request ID: 6f1a2b] Server Error Uncaught Error: Not authenticated at getCurrentUser (../convex/lib/functions.ts:13:19)\n  at handler"
        )
        assertEquals("Sync issue: Server Error Uncaught Error: Not authenticated", syncLabel(long))
        assertEquals("Sync issue: Timed out getting a session token", syncLabel(status(SyncPhase.ERROR, 0, "Timed out getting a session token")))
        assertEquals(
            "Sync issue: Failed to decode JSON, ensure you're using types compatible…",
            syncLabel(status(SyncPhase.ERROR, 1, "Failed to decode JSON, ensure you're using types compatible with Convex in your return value"))
        )
        assertEquals("Offline, 239 pending", syncLabel(status(SyncPhase.OFFLINE, 239, null)))
        assertEquals("Connecting…", syncLabel(status(SyncPhase.CONNECTING, 239, null)))
    }

    @Test
    fun `the trouble screen carries the row too`() {
        CloudDiagnostics.boot("failed at convex: UnsatisfiedLinkError: libconvexmobile.so")
        CloudDiagnostics.guard("released")
        compose.setContent {
            MurmurTheme(store.get().copy(dynamicColor = false)) {
                AccountTroubleScreen(detail = "The sync client could not be started: UnsatisfiedLinkError", nav = TopNav.Back {}, onRetry = {})
            }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("account-trouble").assertIsDisplayed()
        compose.onNodeWithText("Connection details").performScrollTo().assertIsDisplayed()
        snap("account-trouble-connection-details")
        compose.onNodeWithTag("connection-details-copy").performScrollTo().performClick()
        compose.waitForIdle()
        val report = clipboardText()
        assertTrue(report, report.contains("Boot: failed at convex: UnsatisfiedLinkError: libconvexmobile.so"))
        assertTrue(report, report.contains("Convex WebSocket: no client yet"))
    }

    @Test
    fun `before the status arrives the card says Murmur's models is being checked, with no plan and no badge`() {
        compose.setContent {
            CompositionLocalProvider(LocalInferenceView provides view(null)) {
                MurmurTheme(store.get().copy(dynamicColor = false)) {
                    AccountContent(
                        config = config, status = status(SyncPhase.ERROR, 239, "Timed out getting a session token"), name = "Ann Example", email = "ann@example.com",
                        settings = store.get(), nav = TopNav.Back {}, onSyncNow = {}, onSignOut = {}
                    )
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithText("Murmur's models").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Checking your account…").performScrollTo().assertIsDisplayed()
        snap("account-status-loading-billing-off")
        assertEquals(0, compose.onAllNodesWithTextContaining("Free").fetchSemanticsNodesCount())
        assertFalse(compose.onAllNodesWithTextContaining("Waiting for your account status").fetchSemanticsNodesCount() > 0)
        // The sync row says what is wrong rather than "Offline".
        compose.onNodeWithText("Sync issue: Timed out getting a session token").performScrollTo().assertIsDisplayed()
    }
}

private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTextContaining(text: String) =
    onAllNodes(androidx.compose.ui.test.hasText(text, substring = true), useUnmergedTree = true)

private fun androidx.compose.ui.test.SemanticsNodeInteractionCollection.fetchSemanticsNodesCount(): Int = fetchSemanticsNodes().size
