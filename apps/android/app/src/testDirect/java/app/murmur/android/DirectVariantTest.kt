package app.murmur.android

import android.content.pm.PackageManager
import app.murmur.android.update.UpdateManager
import app.murmur.android.update.Updates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** The direct (GitHub Releases) flavor carries the updater and the permissions it needs; the Play flavor carries neither (PlayVariantTest). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DirectVariantTest {
    @Test
    fun `the build is the direct one and its update layer is the GitHub updater`() {
        assertEquals("direct", BuildConfig.DISTRIBUTION)
        assertTrue("owner/name", Regex("""^[\w.-]+/[\w.-]+$""").matches(BuildConfig.UPDATE_REPO))
        assertTrue(Updates.get(RuntimeEnvironment.getApplication()) is UpdateManager)
    }

    @Test
    fun `the manifest asks for the install permissions and declares the install result receiver`() {
        val context = RuntimeEnvironment.getApplication()
        val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS or PackageManager.GET_RECEIVERS)
        val permissions = info.requestedPermissions?.toList().orEmpty()
        assertTrue(permissions.toString(), "android.permission.REQUEST_INSTALL_PACKAGES" in permissions)
        assertTrue(permissions.toString(), "android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION" in permissions)
        val receivers = info.receivers?.map { it.name }.orEmpty()
        assertTrue(receivers.toString(), "app.murmur.android.update.UpdateResultReceiver" in receivers)
    }
}
