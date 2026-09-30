package app.murmur.android.update

import java.net.URI
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/*
 * Pure pieces of the Android updater, mirroring apps/desktop/src/core/update/releases.ts so both
 * apps read the same GitHub release the same way. Everything here is unit-tested without Android.
 */

@Serializable
data class GithubAssetDto(
    val name: String,
    val size: Long = 0,
    val browser_download_url: String,
    /** `sha256:<hex>`, computed by GitHub when the asset was uploaded; null on old assets. */
    val digest: String? = null
)

@Serializable
data class GithubReleaseDto(
    val tag_name: String,
    val name: String? = null,
    val draft: Boolean = false,
    val prerelease: Boolean = false,
    val published_at: String? = null,
    val html_url: String,
    val body: String? = null,
    val assets: List<GithubAssetDto> = emptyList()
)

/** A release the app can offer. */
data class ReleaseInfo(
    /** Without the leading `v`. */
    val version: String,
    val tag: String,
    val name: String,
    val url: String,
    val prerelease: Boolean,
    val notes: String,
    val apk: GithubAssetDto?,
    /** SHA-256 of [apk] (GitHub's asset digest, else the release's SHA256SUMS.txt); null when the release has none. */
    val sha256: String?,
    /** Why [sha256] is null although the release ships an APK: the release itself lacks a checksum for it. */
    val checksumProblem: String? = null
)

/**
 * Outcome of looking up the checksum of an asset. Only [Known] lets the updater install; the two
 * failures are kept apart because they call for different reactions: a release that ships no
 * checksum will never verify, while a checksum file that could not be downloaded right now is a
 * plain network error to retry, and must not be reported as a defect of the release.
 */
sealed class Checksum {
    data class Known(val sha256: String, val source: String) : Checksum()

    /** The release does not carry a checksum for this asset. */
    data class Missing(val reason: String) : Checksum()

    /** The checksum exists but could not be fetched this time. */
    data class Unavailable(val reason: String) : Checksum()
}

enum class UpdatePhase { IDLE, CHECKING, UP_TO_DATE, AVAILABLE, DOWNLOADING, READY, INSTALLING, ERROR }

data class UpdateState(
    val phase: UpdatePhase = UpdatePhase.IDLE,
    val currentVersion: String = "",
    val lastCheckedAt: Long = 0L,
    val release: ReleaseInfo? = null,
    /** 0..1 while downloading. */
    val progress: Float = 0f,
    val downloadedBytes: Long = 0L,
    /** Verified local APK. */
    val downloadedPath: String? = null,
    val error: String? = null,
    /** The install needs "Allow from this source" for Murmur before it can proceed. */
    val needsInstallPermission: Boolean = false,
    /** Set once after the app was updated by itself; the UI shows it and acknowledges. */
    val updatedFrom: String? = null
) {
    /** A verified file can be handed to the package installer. */
    val canInstall: Boolean get() = phase == UpdatePhase.READY && downloadedPath != null && release?.sha256 != null
}

object UpdateSelection {
    const val CHECKSUMS_ASSET = "SHA256SUMS.txt"

    val json: Json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun parseReleases(body: String): List<GithubReleaseDto> = json.decodeFromString(body)

    /**
     * The newest release that is newer than the running version. Pre-releases count when opted in
     * or when the running build is itself a pre-release. A skipped version is withheld until a
     * newer one appears.
     */
    fun selectRelease(
        releases: List<GithubReleaseDto>,
        currentVersion: String,
        includePrereleases: Boolean,
        skippedVersion: String? = null
    ): GithubReleaseDto? {
        val current = Semver.parse(currentVersion)
        val allowPre = includePrereleases || (current?.isPrerelease == true)
        var best: GithubReleaseDto? = null
        for (r in releases) {
            if (r.draft) continue
            val v = Semver.parse(r.tag_name) ?: continue
            if ((r.prerelease || v.isPrerelease) && !allowPre) continue
            if (best == null || Semver.compare(r.tag_name, best.tag_name) > 0) best = r
        }
        val chosen = best ?: return null
        if (Semver.compare(chosen.tag_name, currentVersion) <= 0) return null
        if (!skippedVersion.isNullOrEmpty() && Semver.compare(chosen.tag_name, skippedVersion) == 0) return null
        return chosen
    }

    /** `Murmur-<version>-android.apk`, as uploaded by the Android job of release.yml. */
    fun apkAssetName(tag: String): String = "Murmur-${normalizeVersion(tag)}-android.apk"

    fun normalizeVersion(tag: String): String = tag.trim().removePrefix("v")

    /**
     * The SHA-256 GitHub computed for the asset when it was uploaded (`digest: "sha256:<hex>"` in
     * the release JSON), lowercase hex, or null when the API carries none or something else.
     */
    fun digestOf(asset: GithubAssetDto): String? {
        val m = Regex("""^sha256:([a-fA-F0-9]{64})$""").matchEntire(asset.digest?.trim() ?: return null) ?: return null
        return m.groupValues[1].lowercase()
    }

    /** `sha256sum` output (`<hex>  <name>` or `<hex> *<name>`) -> name to lowercase digest. */
    fun parseChecksums(text: String): Map<String, String> {
        val out = HashMap<String, String>()
        val re = Regex("""^([a-fA-F0-9]{64})\s+\*?(.+)$""")
        for (raw in text.lines()) {
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("#")) continue
            val m = re.matchEntire(line) ?: continue
            out[m.groupValues[2].trim()] = m.groupValues[1].lowercase()
        }
        return out
    }

    /** Downloads are only accepted from the release origin (https, or loopback for tests). */
    fun isTrustedAssetUrl(url: String, allowedOrigin: String): Boolean {
        val u = runCatching { URI(url) }.getOrNull() ?: return false
        val allowed = runCatching { URI(allowedOrigin) }.getOrNull() ?: return false
        if (u.scheme == null || u.host == null) return false
        if (!u.scheme.equals(allowed.scheme, ignoreCase = true)) return false
        if (!u.host.equals(allowed.host, ignoreCase = true)) return false
        if (u.port != allowed.port) return false
        val loopback = u.host == "localhost" || u.host == "127.0.0.1"
        return u.scheme.equals("https", ignoreCase = true) || loopback
    }

    /**
     * Resolve the checksum of [asset] without touching the network: GitHub's own digest of the
     * upload wins; otherwise [sums] (the body of SHA256SUMS.txt, when the release ships one and
     * it was downloaded) is consulted. [sumsPresent] tells whether the release lists the file at
     * all; [sumsFetchError] is the reason its download failed, when it did.
     */
    fun resolveChecksum(
        release: GithubReleaseDto,
        asset: GithubAssetDto,
        sumsPresent: Boolean,
        sums: String?,
        sumsFetchError: String? = null
    ): Checksum {
        digestOf(asset)?.let { return Checksum.Known(it, "GitHub asset digest") }
        val label = "Murmur ${normalizeVersion(release.tag_name)}"
        if (!sumsPresent) {
            return Checksum.Missing("$label ships no $CHECKSUMS_ASSET, so Murmur cannot verify its Android build.")
        }
        if (sums == null) {
            return Checksum.Unavailable(
                "Could not download $CHECKSUMS_ASSET for $label${if (sumsFetchError.isNullOrBlank()) "" else " ($sumsFetchError)"}. Murmur will try again."
            )
        }
        return parseChecksums(sums)[asset.name]?.let { Checksum.Known(it, CHECKSUMS_ASSET) }
            ?: Checksum.Missing("The $CHECKSUMS_ASSET of $label has no entry for ${asset.name}, so Murmur cannot verify it.")
    }

    fun describe(release: GithubReleaseDto, apk: GithubAssetDto?, checksum: Checksum?): ReleaseInfo {
        val v = Semver.parse(release.tag_name)
        return ReleaseInfo(
            version = normalizeVersion(release.tag_name),
            tag = release.tag_name,
            name = release.name?.trim().takeUnless { it.isNullOrEmpty() } ?: release.tag_name,
            url = release.html_url,
            prerelease = release.prerelease || (v?.isPrerelease == true),
            notes = release.body ?: "",
            apk = apk,
            sha256 = (checksum as? Checksum.Known)?.sha256,
            checksumProblem = when (checksum) {
                is Checksum.Missing -> checksum.reason
                is Checksum.Unavailable -> checksum.reason
                else -> null
            }
        )
    }
}
