package app.murmur.android

import app.murmur.android.update.Checksum
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
            published_at = "2026-09-01T10:00:00Z", html_url = "https://github.com/BenItBuhner/Murmur/releases/tag/$tag",
            body = "notes", assets = assets
        )

    private fun asset(name: String, base: String = "https://github.com/BenItBuhner/Murmur/releases/download/v0.2.0") =
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
              "published_at":"2026-09-01T10:00:00Z","html_url":"https://github.com/BenItBuhner/Murmur/releases/tag/v0.2.0",
              "body":"notes","zipball_url":"ignored","author":{"login":"x"},
              "assets":[
                {"name":"Murmur-0.2.0-android.apk","size":42,"browser_download_url":"https://github.com/BenItBuhner/Murmur/releases/download/v0.2.0/Murmur-0.2.0-android.apk","content_type":"application/vnd.android.package-archive"},
                {"name":"SHA256SUMS.txt","size":1,"browser_download_url":"https://github.com/BenItBuhner/Murmur/releases/download/v0.2.0/SHA256SUMS.txt"}
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
        val info = UpdateSelection.describe(r, apk, Checksum.Known(sums.getValue("Murmur-0.2.0-android.apk"), UpdateSelection.CHECKSUMS_ASSET))
        assertEquals("0.2.0", info.version)
        assertFalse(info.prerelease)
        assertEquals(apk, info.apk)
        assertEquals("ab".repeat(32), info.sha256)
        assertNull(info.checksumProblem)
        val unverifiable = UpdateSelection.describe(r, apk, Checksum.Missing("no line"))
        assertNull(unverifiable.sha256)
        assertEquals("no line", unverifiable.checksumProblem)
    }

    /**
     * The API responses GitHub really gave for v0.6.0 and v0.5.11 (fixtures/updates): the APK is
     * found by its versioned name, its digest comes with the release JSON and agrees with the line
     * SHA256SUMS.txt carries for it, so both paths verify the same bytes.
     */
    @Test
    fun `resolves the APK checksum from the real v0-6-0 and v0-5-11 API responses`() {
        for ((tag, sha) in UpdateFixtures.realApkSha256) {
            val r = UpdateSelection.parseReleases("[${UpdateFixtures.releaseJson(tag)}]").single()
            assertEquals(tag, r.tag_name)
            assertFalse(r.draft || r.prerelease)
            assertEquals(29, r.assets.size)
            val apkName = UpdateSelection.apkAssetName(r.tag_name)
            val apk = r.assets.single { it.name == apkName }
            assertTrue(apk.size > 30_000_000)
            assertTrue(UpdateSelection.isTrustedAssetUrl(apk.browser_download_url, "https://github.com"))
            assertEquals(sha, UpdateSelection.digestOf(apk))

            val sums = r.assets.single { it.name == UpdateSelection.CHECKSUMS_ASSET }
            assertTrue(UpdateSelection.isTrustedAssetUrl(sums.browser_download_url, "https://github.com"))
            val parsed = UpdateSelection.parseChecksums(UpdateFixtures.checksums(tag))
            assertEquals(28, parsed.size)
            assertEquals(sha, parsed[apkName])
            assertEquals(sha, parsed["Murmur-android.apk"])

            assertEquals(Checksum.Known(sha, "GitHub asset digest"), UpdateSelection.resolveChecksum(r, apk, sumsPresent = true, sums = null))
            val noDigest = apk.copy(digest = null)
            assertEquals(
                Checksum.Known(sha, UpdateSelection.CHECKSUMS_ASSET),
                UpdateSelection.resolveChecksum(r, noDigest, sumsPresent = true, sums = UpdateFixtures.checksums(tag))
            )
            assertEquals(
                Checksum.Unavailable("Could not download SHA256SUMS.txt for Murmur ${tag.removePrefix("v")} (HTTP 503). Murmur will try again."),
                UpdateSelection.resolveChecksum(r, noDigest, sumsPresent = true, sums = null, sumsFetchError = "HTTP 503")
            )
            assertTrue(UpdateSelection.resolveChecksum(r, noDigest, sumsPresent = false, sums = null) is Checksum.Missing)
            assertTrue(UpdateSelection.resolveChecksum(r, noDigest, sumsPresent = true, sums = "not a checksum file") is Checksum.Missing)
            assertNull(UpdateSelection.digestOf(apk.copy(digest = "sha512:" + "0".repeat(128))))
            assertNull(UpdateSelection.digestOf(apk.copy(digest = "sha256:short")))
        }
        // Both real releases in one feed: a 0.5.11 phone is offered v0.6.0, a 0.6.0 phone nothing.
        val feed = UpdateSelection.parseReleases("[${UpdateFixtures.releaseJson("v0.6.0")},${UpdateFixtures.releaseJson("v0.5.11")}]")
        assertEquals("v0.6.0", UpdateSelection.selectRelease(feed, "0.5.11", false)?.tag_name)
        assertNull(UpdateSelection.selectRelease(feed, "0.6.0", false))
    }

    @Test
    fun `only trusts assets from the release origin`() {
        val gh = "https://github.com"
        assertTrue(UpdateSelection.isTrustedAssetUrl("https://github.com/BenItBuhner/Murmur/releases/download/v0.2.0/x.apk", gh))
        assertFalse(UpdateSelection.isTrustedAssetUrl("https://evil.example/x.apk", gh))
        assertFalse(UpdateSelection.isTrustedAssetUrl("http://github.com/x.apk", gh))
        assertTrue(UpdateSelection.isTrustedAssetUrl("http://127.0.0.1:8080/x.apk", "http://127.0.0.1:8080"))
        assertFalse(UpdateSelection.isTrustedAssetUrl("nonsense", gh))
        val r = release("v0.2.0", assets = listOf(asset("Murmur-0.2.0-android.apk", base = "https://evil.example")))
        assertFalse(UpdateSelection.isTrustedAssetUrl(r.assets[0].browser_download_url, gh))
    }
}
