package app.murmur.android

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.TopNav
import app.murmur.android.ui.UpdatesScreen
import app.murmur.android.ui.theme.MurmurTheme
import app.murmur.android.update.NoUpdater
import app.murmur.android.update.Updates
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Google Play flavor has no updater: not as a switched-off feature but as code that is not
 * there. Play's Device and Network Abuse policy forbids an app updating itself outside Play, so
 * this build never checks GitHub, downloads an APK or touches the package installer, asks for no
 * install permission, and its Updates screen points at the listing. verifyPlayReleaseApk proves
 * the same of the built APK and bundle; this proves it of the compiled classes and the manifest.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PlayVariantTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val context: Context get() = RuntimeEnvironment.getApplication()

    @Test
    fun `the build is the Play one and its update layer does nothing`() {
        assertEquals("play", BuildConfig.DISTRIBUTION)
        val updater = Updates.get(context)
        assertSame(NoUpdater, updater)
        assertNull(updater.readyVersion.value)
        updater.onAppVisible()
        updater.onAppHidden()
        val scope = CoroutineScope(SupervisorJob())
        updater.startBackgroundChecks(scope)
        assertEquals("no background work was started", 0, scope.coroutineContext[Job]!!.children.count())
        assertNull(updater.readyVersion.value)
    }

    @Test
    fun `none of the updater is compiled into this variant`() {
        for (name in listOf("UpdateManager", "UpdateResultReceiver", "UpdateSelection", "UpdateSource", "GithubReleaseDto", "Semver")) {
            try {
                Class.forName("app.murmur.android.update.$name")
                fail("app.murmur.android.update.$name is compiled into the Play variant")
            } catch (expected: ClassNotFoundException) {
                // The class does not exist here; that is the point.
            }
        }
        // BuildConfig has no updater repository either: there is nothing to follow.
        assertTrue(BuildConfig::class.java.declaredFields.none { it.name == "UPDATE_REPO" })
    }

    @Test
    fun `the manifest asks for no install permission and declares no install receiver`() {
        val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS or PackageManager.GET_RECEIVERS)
        val permissions = info.requestedPermissions?.toList().orEmpty()
        assertTrue("the merged manifest was read: $permissions", "android.permission.RECORD_AUDIO" in permissions)
        assertFalse(permissions.toString(), "android.permission.REQUEST_INSTALL_PACKAGES" in permissions)
        assertFalse(permissions.toString(), "android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION" in permissions)
        val receivers = info.receivers?.map { it.name }.orEmpty()
        assertTrue(receivers.toString(), receivers.none { it.contains("UpdateResultReceiver") })
    }

    @Test
    fun `the Updates screen points at the Play listing and offers nothing to check, download or install`() {
        context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        val store = SettingsStore(context)
        compose.setContent {
            val settings by store.flow.collectAsState()
            MurmurTheme(settings.copy(dynamicColor = false)) { UpdatesScreen(store, settings, TopNav.None) }
        }
        compose.onNodeWithText("Murmur ${BuildConfig.VERSION_NAME}").assertIsDisplayed()
        compose.onNodeWithText("This copy of Murmur comes from Google Play, which keeps it up to date.").assertIsDisplayed()
        for (absent in listOf("Check for updates", "Install", "Download", "Download updates automatically", "Check automatically", "Include pre-releases")) {
            compose.onNodeWithText(absent).assertDoesNotExist()
        }

        compose.onNodeWithText("Open Google Play").performClick()
        compose.waitForIdle()
        val started = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, started.action)
        assertEquals("market://details?id=${BuildConfig.APPLICATION_ID}", started.dataString)
        assertEquals("app.murmur.android", BuildConfig.APPLICATION_ID)
    }
}
