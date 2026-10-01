package app.murmur.android

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the shape of the install path in the sources, so a future change cannot quietly add a
 * second way into the package installer: `UpdateManager.install()` is called from the Install
 * button on the Updates screen and nowhere else, the manager never calls it on itself, and the
 * shared code (src/main, compiled into the Play flavor too) knows nothing of the updater beyond
 * the `Updater` seam. The runtime side of the same guarantee is UpdateManagerTest.
 */
class InstallPathGuardTest {
    private val module: File = listOf(File("."), File("app"), File("apps/android/app"))
        .firstOrNull { File(it, "src/main/java/app/murmur/android/MainActivity.kt").exists() }
        ?: error("app module not found from ${File(".").absolutePath}")

    private fun kotlinSources(sourceSet: String): List<File> =
        File(module, "src/$sourceSet/java").walk().filter { it.isFile && it.extension == "kt" }.toList()

    @Test
    fun `install is called from the Updates screen's button and from nowhere else`() {
        val callers = (kotlinSources("main") + kotlinSources("direct") + kotlinSources("play"))
            .filter { Regex("""\.install\(\)""").containsMatchIn(it.readText()) }
            .map { it.name }
        assertEquals(listOf("UpdateScreens.kt"), callers)
        val screen = File(module, "src/direct/java/app/murmur/android/ui/UpdateScreens.kt").readText()
        assertEquals("one Install button", 1, Regex("""manager\.install\(\)""").findAll(screen).count())
        assertTrue(screen.contains("""PrimaryButton("Install", onClick = { manager.install() }"""))
    }

    @Test
    fun `the manager never installs on its own`() {
        val manager = File(module, "src/direct/java/app/murmur/android/update/UpdateManager.kt").readText()
        // A bare `install()` would be the manager calling itself; the definition is the only `install()` in it.
        assertEquals(0, Regex("""(?<!fun )(?<![\w.])install\(\)""").findAll(manager).count())
        assertEquals("the installer is reached from one line", 1, Regex("""commitInstall\(""").findAll(manager).count())
        // The idle wait and the unattended path of 0.6.3 are gone for good.
        for (gone in listOf("autoInstall", "awaitingPermission", "isIdle")) {
            assertTrue("$gone is back", !manager.contains(gone))
        }
    }

    @Test
    fun `the shared code knows the updater only through the seam`() {
        val main = kotlinSources("main")
        val seam = main.filter { it.name == "Updater.kt" }
        assertEquals(1, seam.size)
        // The seam's own documentation names the implementations; nothing else in src/main may.
        val leaks = (main - seam.toSet()).filter { Regex("""\bUpdateManager\b|\bPackageInstaller\b|commitInstall|UpdatePhase|UpdateState\b""").containsMatchIn(it.readText()) }
        assertEquals(emptyList<String>(), leaks.map { it.name })
        val packageInstallerUsers = (kotlinSources("direct") + kotlinSources("play"))
            .filter { it.readText().contains("PackageInstaller") }
            .map { it.name }
            .sorted()
        assertEquals(listOf("UpdateManager.kt", "UpdateResultReceiver.kt"), packageInstallerUsers)
    }
}
