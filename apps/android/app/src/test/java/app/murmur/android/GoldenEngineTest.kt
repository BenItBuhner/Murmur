package app.murmur.android

import app.murmur.android.settings.Tone
import app.murmur.android.text.AppCategory
import app.murmur.android.text.DictionaryTerm
import app.murmur.android.text.FormatContext
import app.murmur.android.text.NumberSignature
import app.murmur.android.text.Prompt
import app.murmur.android.text.Verify
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins the Kotlin port of the text engine to the TypeScript original. The golden file is written
 * by `npm run golden` in packages/text-engine from the TypeScript code; this test asserts that the
 * Kotlin prompt builder, number reader, output cleaner and verifier produce byte-identical results
 * for the same inputs. When the engine changes, regenerate the golden file and port the change.
 */
class GoldenEngineTest {
    private val golden: JSONObject by lazy {
        val candidates = listOf(
            File("../../../packages/text-engine/golden/engine.golden.json"),
            File("../../packages/text-engine/golden/engine.golden.json"),
            File("packages/text-engine/golden/engine.golden.json")
        )
        val file = candidates.firstOrNull { it.exists() }
            ?: error("golden file not found from ${File(".").absolutePath}; run `npm run golden` in packages/text-engine")
        JSONObject(file.readText())
    }

    private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

    private fun contextOf(json: JSONObject): FormatContext {
        val dictionary = json.optJSONArray("dictionary")?.let { arr ->
            (0 until arr.length()).map { i ->
                val d = arr.getJSONObject(i)
                DictionaryTerm(d.getString("word"), d.optJSONArray("aliases")?.strings() ?: emptyList(), d.optBoolean("fuzzy", false))
            }
        } ?: emptyList()
        return FormatContext(
            category = AppCategory.entries.first { it.id == json.getString("category") },
            tone = Tone.from(json.getString("tone")),
            app = json.optString("app").takeIf { json.has("app") && !json.isNull("app") },
            language = json.optString("language").takeIf { json.has("language") && !json.isNull("language") },
            precedingText = json.optString("precedingText").takeIf { json.has("precedingText") && !json.isNull("precedingText") },
            instructions = json.optString("instructions").takeIf { json.has("instructions") && !json.isNull("instructions") },
            dictionary = dictionary,
            keepVerbatim = json.optJSONArray("keepVerbatim")?.strings() ?: emptyList()
        )
    }

    @Test
    fun `prompt messages are byte-identical to the TypeScript engine`() {
        val prompts = golden.getJSONArray("prompts")
        assertTrue(prompts.length() >= 3)
        for (i in 0 until prompts.length()) {
            val case = prompts.getJSONObject(i)
            val expected = case.getJSONArray("messages")
            val actual = Prompt.buildFormatMessages(case.getString("transcript"), contextOf(case.getJSONObject("context")), strict = case.optBoolean("strict", false))
            assertEquals("${case.getString("name")}: message count", expected.length(), actual.size)
            for (k in 0 until expected.length()) {
                val e = expected.getJSONObject(k)
                assertEquals("${case.getString("name")}: role of message $k", e.getString("role"), actual[k].role)
                assertEquals("${case.getString("name")}: content of message $k", e.getString("content"), actual[k].content)
            }
        }
    }

    @Test
    fun `number signatures agree`() {
        val cases = golden.getJSONArray("signatures")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(c.getString("text"), c.getString("signature"), NumberSignature.digitSignature(c.getString("text")))
        }
    }

    @Test
    fun `output cleaning agrees`() {
        val cases = golden.getJSONArray("clean")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(c.getString("output"), c.getString("cleaned"), Verify.cleanModelOutput(c.getString("output"), c.getString("transcript")))
        }
    }

    @Test
    fun `verdicts agree`() {
        val cases = golden.getJSONArray("verify")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val options = c.optJSONObject("options")
            val v = Verify.verifyOutput(
                c.getString("transcript"),
                c.getString("output"),
                language = options?.optString("language")?.takeIf { options.has("language") },
                keepVerbatim = options?.optJSONArray("keepVerbatim")?.strings() ?: emptyList()
            )
            assertEquals("${c.getString("transcript")} -> ${c.getString("output")}", c.getBoolean("ok"), v.ok)
            assertEquals("${c.getString("transcript")} -> ${c.getString("output")}", if (c.isNull("reason")) null else c.getString("reason"), v.reason)
        }
    }
}
