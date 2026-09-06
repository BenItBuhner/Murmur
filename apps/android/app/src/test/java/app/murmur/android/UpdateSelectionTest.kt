package app.murmur.android

import app.murmur.android.update.GithubAssetDto
import app.murmur.android.update.GithubReleaseDto
import app.murmur.android.update.Semver
import app.murmur.android.update.UpdateSelection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure update rules; the same cases as apps/desktop/tests/update-core.test.ts. */
class UpdateSelectionTest {
    private fun release(tag: String, prerelease: Boolean = tag.contains('-'), draft: Boolean = false, assets: List<GithubAssetDto> = emptyList()) =
        GithubReleaseDto(
            tag_name = tag, name = "Murmur $tag", draft = draft, prerelease = prerelease,
            published_at = "2026-09-01T10:00:00Z", html_url = "https://github.com/BenItBuhner/voxflow/releases/tag/$tag",
            body = "notes", assets = assets
        )

    private fun asset(name: String, base: String = "https://github.com/BenItBuhner/voxflow/releases/download/v0.2.0") =
        GithubAssetDto(name, 1234, "$base/$name")

    @Test
    fun `semver parses and orders like the desktop`() {
        assertEquals(Semver(1, 2, 3, emptyList()), Semver.parse("v1.2.3"))
        assertEquals(listOf("beta", "4"), Semver.parse("0.2.0-beta.4")!!.prerelease)
        assertNull(Semver.parse("latest"))
        assertNull(Semver.parse("1.2"))
        assertNull(Semver.parse("01.2.3"))
        val sorted = listOf(
            "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2",
            "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"
        )
        for (i in 1 until sorted.size) {
            assertTrue("${sorted[i - 1]} < ${sorted[i]}", Semver.compare(sorted[i - 1], sorted[i]) < 0)
            assertTrue("${sorted[i]} > ${sorted[i - 1]}", Semver.compare(sorted[i], sorted[i - 1]) > 0)
        }
        assertEquals(0, Semver.compare("v0.1.0", "0.1.0"))
        assertTrue(Semver.compare("garbage", "0.1.0") < 0)
        assertEquals("0.2.0-beta.1", Semver.parse("v0.2.0-beta.1").toString())
    }

    @Test
    fun `the version code scheme in build gradle stays monotonic with semver order`() {
        // Mirrors versionCodeFor() in app/build.gradle.kts so a newer tag is always a higher code.
        fun code(v: String): Int {
            val s = Semver.parse(v)!!
            val release = if (!s.isPrerelease) 99
            else (s.prerelease.lastOrNull { it.all(Char::isDigit) }?.toInt() ?: 0).coerceIn(0, 98)
            return s.major * 1_000_000 + s.minor * 10_000 + s.patch * 100 + release
        }
        assertEquals(1_020_399, code("1.2.3"))
        assertEquals(1_020_304, code("1.2.3-beta.4"))
        assertTrue(code("0.1.0") < code("0.2.0-beta.1"))
        assertTrue(code("0.2.0-beta.1") < code("0.2.0"))
        assertTrue(code("0.2.0") < code("0.2.1"))
    }

    @Test
    fun `selects the newest eligible release`() {
        val feed = listOf(
            release("v0.3.0-beta.1"), release("v0.2.1"), release("v0.2.0"), release("v0.1.0"),
            release("v9.9.9", draft = true), release("nightly")
        )
        assertEquals("v0.2.1", UpdateSelection.selectRelease(feed, "0.1.0", false)?.tag_name)
        assertNull(UpdateSelection.selectRelease(feed, "0.2.1", false))
        assertNull(UpdateSelection.selectRelease(feed, "5.0.0", true))
        assertEquals("v0.3.0-beta.1", UpdateSelection.selectRelease(feed, "0.1.0", true)?.tag_name)
        assertEquals("v0.3.0-beta.1", UpdateSelection.selectRelease(feed, "0.2.1-beta.3", false)?.tag_name)
        assertEquals("v0.2.1", UpdateSelection.selectRelease(listOf(release("v0.2.1")), "0.2.1-beta.3", false)?.tag_name)
        assertNull(UpdateSelection.selectRelease(feed, "0.1.0", false, skippedVersion = "0.2.1"))
        assertEquals("v0.2.2", UpdateSelection.selectRelease(listOf(release("v0.2.2")) + feed, "0.1.0", false, "0.2.1")?.tag_name)
    }

    @Test
    fun `parses the GitHub feed and finds the APK plus its checksum`() {
        val body = """
            [{"tag_name":"v0.2.0","name":"Murmur v0.2.0","draft":false,"prerelease":false,
              "published_at":"2026-09-01T10:00:00Z","html_url":"https://github.com/BenItBuhner/voxflow/releases/tag/v0.2.0",
              "body":"notes","zipball_url":"ignored","author":{"login":"x"},
              "assets":[
                {"name":"Murmur-0.2.0-android.apk","size":42,"browser_download_url":"https://github.com/BenItBuhner/voxflow/releases/download/v0.2.0/Murmur-0.2.0-android.apk","content_type":"application/vnd.android.package-archive"},
                {"name":"SHA256SUMS.txt","size":1,"browser_download_url":"https://github.com/BenItBuhner/voxflow/releases/download/v0.2.0/SHA256SUMS.txt"}
              ]}]
        """.trimIndent()
        val releases = UpdateSelection.parseReleases(body)
        assertEquals(1, releases.size)
        val r = releases[0]
        assertEquals("Murmur-0.2.0-android.apk", UpdateSelection.apkAssetName(r.tag_name))
        val apk = r.assets.first { it.name == UpdateSelection.apkAssetName(r.tag_name) }
        assertEquals(42L, apk.size)
        val sums = UpdateSelection.parseChecksums(
            "ab".repeat(32) + "  Murmur-0.2.0-android.apk\n" + "CD".repeat(32) + " *Murmur-0.2.0-setup.exe\r\nnot a line\n"
        )
        assertEquals("ab".repeat(32), sums["Murmur-0.2.0-android.apk"])
        assertEquals("cd".repeat(32), sums["Murmur-0.2.0-setup.exe"])
        assertEquals(2, sums.size)
        val info = UpdateSelection.describe(r, apk, sums["Murmur-0.2.0-android.apk"])
        assertEquals("0.2.0", info.version)
        assertFalse(info.prerelease)
        assertEquals(apk, info.apk)
    }

    @Test
    fun `only trusts assets from the release origin`() {
        val gh = "https://github.com"
        assertTrue(UpdateSelection.isTrustedAssetUrl("https://github.com/BenItBuhner/voxflow/releases/download/v0.2.0/x.apk", gh))
        assertFalse(UpdateSelection.isTrustedAssetUrl("https://evil.example/x.apk", gh))
        assertFalse(UpdateSelection.isTrustedAssetUrl("http://github.com/x.apk", gh))
        assertTrue(UpdateSelection.isTrustedAssetUrl("http://127.0.0.1:8080/x.apk", "http://127.0.0.1:8080"))
        assertFalse(UpdateSelection.isTrustedAssetUrl("nonsense", gh))
        val r = release("v0.2.0", assets = listOf(asset("Murmur-0.2.0-android.apk", base = "https://evil.example")))
        assertFalse(UpdateSelection.isTrustedAssetUrl(r.assets[0].browser_download_url, gh))
    }
}
