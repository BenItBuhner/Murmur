package app.murmur.android

import org.json.JSONObject
import java.io.File

/**
 * Bytes captured from a real OpenAI-compatible endpoint, shared with the TypeScript engine's tests
 * (packages/text-engine/tests/fixtures/live): the speech model's responses to espeak-ng clips,
 * requested exactly as [app.murmur.android.stt.SttClient] requests them, and one completion from
 * the formatting model; credentials and request ids stripped.
 */
object LiveFixtures {
    private val dir: File by lazy {
        listOf(
            "../../../packages/text-engine/tests/fixtures/live",
            "../../packages/text-engine/tests/fixtures/live",
            "packages/text-engine/tests/fixtures/live"
        ).map(::File).firstOrNull { it.isDirectory }
            ?: error("live fixtures not found from ${File(".").absolutePath}")
    }

    fun raw(name: String): String = File(dir, name).readText()

    fun json(name: String): JSONObject = JSONObject(raw(name))

    fun transcript(name: String): String = json(name).getString("text")
}
