package app.murmur.android

import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The GitHub Releases API as it answered for the real releases, saved under
 * src/test/resources/fixtures/updates (`GET /repos/BenItBuhner/Murmur/releases/tags/<tag>` and the
 * releases' SHA256SUMS.txt, fetched anonymously on 2026-09-30). The updater reads the list endpoint,
 * whose entries are these very objects.
 */
object UpdateFixtures {
    const val REPO = "BenItBuhner/Murmur"

    /** The published digests of the Android APKs, as GitHub computed them and as SHA256SUMS.txt lists them. */
    val realApkSha256 = mapOf(
        "v0.6.0" to "0593d5ac183abebc8c86d8609b9b927bcda372c2b956d7b2991b9ad25c14592c",
        "v0.5.11" to "d7814b6f7b1d306e9d570e977055cef6d8f711114d53e758be1385f849ab1cb3"
    )

    private fun resource(name: String): String =
        checkNotNull(UpdateFixtures::class.java.getResourceAsStream("/fixtures/updates/$name")) { "missing fixture $name" }
            .use { it.readBytes().decodeToString() }

    /** The raw API response for one release. */
    fun releaseJson(tag: String): String = resource("github-release-$tag.json")

    /** The raw SHA256SUMS.txt of one release. */
    fun checksums(tag: String): String = resource("SHA256SUMS-$tag.txt")

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** A release object with every asset's `digest` removed, as an older GitHub or a stale asset would answer. */
    fun withoutDigests(release: JsonObject): JsonObject = mapAssets(release) { asset -> JsonObject(asset - "digest") }

    /** A release object without its SHA256SUMS.txt asset. */
    fun withoutChecksumsAsset(release: JsonObject): JsonObject =
        JsonObject(release + ("assets" to JsonArray(release.getValue("assets").jsonArray.filter { it.jsonObject.name() != "SHA256SUMS.txt" })))

    /**
     * The release with the Android APK (versioned name and alias) standing for [payload]: `size` and
     * `digest` describe the bytes a fake download host serves instead of the 36 MB real build.
     */
    fun withApkPayload(release: JsonObject, payload: ByteArray): JsonObject = mapAssets(release) { asset ->
        if (!asset.name().endsWith("-android.apk")) asset
        else JsonObject(asset + ("size" to JsonPrimitive(payload.size)) + ("digest" to JsonPrimitive("sha256:${sha256Hex(payload)}")))
    }

    /** The real SHA256SUMS.txt with the APK lines rewritten for [payload], everything else untouched. */
    fun checksumsForApkPayload(tag: String, payload: ByteArray): String =
        checksums(tag).replace(realApkSha256.getValue(tag), sha256Hex(payload))

    fun parse(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    /** The list endpoint's body for [releases], with every github.com link pointing at [origin]. */
    fun listBody(origin: String, vararg releases: JsonObject): String =
        JsonArray(releases.toList()).toString().replace("https://github.com/", "$origin/")

    private fun JsonObject.name(): String = getValue("name").jsonPrimitive.content

    private fun mapAssets(release: JsonObject, f: (JsonObject) -> JsonElement): JsonObject =
        JsonObject(release + ("assets" to JsonArray(release.getValue("assets").jsonArray.map { f(it.jsonObject) })))
}
