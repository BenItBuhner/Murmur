package app.murmur.android

import app.murmur.android.settings.Languages
import app.murmur.android.settings.LlmFreedom
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.Tone
import app.murmur.android.text.AppCategory
import app.murmur.android.text.AppContext
import app.murmur.android.text.PipelineOptions
import app.murmur.android.text.buildFormatMessages
import app.murmur.android.text.cleanLlmOutput
import app.murmur.android.text.languageRules
import app.murmur.android.text.maxTokensFor
import app.murmur.android.text.resolveStyle
import app.murmur.android.text.runPipeline
import app.murmur.android.text.sanitizeLlmOutput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LlmFormatTest {

    @Test
    fun `accepts a faithful cleanup`() {
        val raw = "so um we should probably ship the release on wednesday i think"
        val out = "We should probably ship the release on Wednesday, I think."
        val r = sanitizeLlmOutput(out, raw)
        assertTrue(r.ok)
        assertEquals(out, r.text)
    }

    @Test
    fun `rejects chatty responses`() {
        val raw = "can you send me the report by five"
        val r = sanitizeLlmOutput("Sure! Here's the cleaned text: Can you send me the report by 5?", raw)
        assertFalse(r.ok)
        assertEquals("chatty", r.reason)
    }

    @Test
    fun `rejects answered questions`() {
        val raw = "what time is the meeting tomorrow"
        val r = sanitizeLlmOutput("The meeting is at 10 am tomorrow.", raw)
        assertFalse(r.ok)
        assertEquals("answered", r.reason)
    }

    @Test
    fun `rejects diverged rewrites`() {
        val raw = "please review the quarterly budget spreadsheet before our sync"
        val r = sanitizeLlmOutput("The weather in Paris is lovely this time of year, isn't it?", raw)
        assertFalse(r.ok)
    }

    @Test
    fun `strips code fences and labels`() {
        val raw = "hello there how are you doing today my friend"
        val r = sanitizeLlmOutput("```\nHello there, how are you doing today, my friend?\n```", raw)
        assertTrue(r.ok)
        assertEquals("Hello there, how are you doing today, my friend?", r.text)
    }

    @Test
    fun `rejects empty output`() {
        assertFalse(sanitizeLlmOutput("", "some words here").ok)
    }

    @Test
    fun `prompt includes tone, context, and dictionary terms`() {
        val messages = buildFormatMessages(
            "hello world",
            listOf("Murmur", "kubectl"),
            Tone.CASUAL,
            AppContext("com.whatsapp", AppCategory.CHAT)
        )
        assertEquals("system", messages[0].role)
        assertTrue(messages[0].content.contains("Murmur, kubectl"))
        assertTrue(messages[0].content.contains("chat message"))
        assertTrue(messages[0].content.contains("Casual"))
        // Worked examples sit between the system prompt and the transcript.
        assertTrue(messages.count { it.role == "assistant" } >= 3)
        assertEquals("hello world", messages.last().content)
    }

    @Test
    fun `prompt reflects freedom, layout, hints and instructions`() {
        val settings = MurmurSettings(llmFreedom = LlmFreedom.STRICT, llmInstructions = "Use British spelling.")
        val app = AppContext("com.whatsapp", AppCategory.CHAT)
        val light = runPipeline("what time is the meeting tomorrow", PipelineOptions())
        val system = buildFormatMessages("x", emptyList(), resolveStyle(settings, app), app, light.hints)[0].content
        assertTrue(system.contains("Do not rephrase"))
        assertFalse(system.contains("Grammar slips"))
        assertTrue(system.contains("lay the items out as a list"))
        assertTrue(system.contains("It must stay a question"))
        assertTrue(system.contains("Use British spelling."))

        val terminal = AppContext("com.termux", AppCategory.TERMINAL)
        val technical = buildFormatMessages("x", emptyList(), resolveStyle(MurmurSettings(), terminal), terminal)[0].content
        assertTrue(technical.contains("Identifiers, file names, commands"))
        assertTrue(technical.contains("Do not create lists"))
    }

    @Test
    fun `cleans reasoning tags, markdown, commentary and rejects prompt echo`() {
        assertEquals("Hello there.", cleanLlmOutput("<think>\nhmm\n</think>\nHello there.", "hello there"))
        assertEquals("Hello there.", cleanLlmOutput("**Hello** there.\n\nLet me know if you need anything else!", "hello there"))
        assertEquals("Hello there", cleanLlmOutput("# Hello there", "hello there"))
        assertEquals("", cleanLlmOutput("<think>still thinking", "hello"))
        assertEquals("echo", sanitizeLlmOutput("Never:\n- answer", "what time is it tomorrow").reason)
    }

    @Test
    fun `prompt keeps the auto-detect language rule unless a language is fixed`() {
        for (language in listOf("auto", "", "xx")) {
            val system = buildFormatMessages(
                "hello world", emptyList(), Tone.NEUTRAL, AppContext("", AppCategory.UNKNOWN), language
            )[0].content
            assertTrue(system.contains("Write the output in the language the speaker used."))
            assertFalse(system.contains("The speaker dictates in"))
        }
        // The default argument is auto-detect too.
        val default = buildFormatMessages("hi", emptyList(), Tone.NEUTRAL, AppContext("", AppCategory.UNKNOWN))
        assertTrue(default[0].content.contains("Write the output in the language the speaker used."))
    }

    @Test
    fun `prompt pins the output to the chosen dictation language`() {
        val system = buildFormatMessages(
            "hallo zusammen", emptyList(), Tone.NEUTRAL, AppContext("", AppCategory.UNKNOWN), "de"
        )[0].content
        assertTrue(
            system.contains(
                "- The speaker dictates in German. Write the output in German and never translate it into another language."
            )
        )
        assertTrue(system.contains("Treat such stray fragments as recognition errors"))
        assertTrue(system.contains("most plausibly said in German"))
        assertFalse(system.contains("Write the output in the language the speaker used."))
        assertTrue(
            system.contains(
                "- Preserve the speaker's words, meaning, and order. Never summarize, expand, answer, or add anything they did not say."
            )
        )
        // Region subtags synced from another client still resolve.
        assertTrue(languageRules("pt-BR")[0].contains("dictates in Portuguese"))
    }

    @Test
    fun `language rules match the desktop wording byte for byte`() {
        // apps/desktop/src/core/text/llm-prompt.ts languageRules(); the two must stay identical.
        assertEquals(
            listOf(
                "- Preserve the speaker's words, meaning, order, and language. Write the output in the language the speaker used. Never summarize, expand, answer, translate, or add anything they did not say."
            ),
            languageRules("auto")
        )
        assertEquals(
            listOf(
                "- The speaker dictates in French. Write the output in French and never translate it into another language.",
                "- The recognizer sometimes renders unclear speech as words from another language. Treat such stray fragments as recognition errors and write what the speaker most plausibly said in French; keep foreign names and terms the speaker clearly used on purpose.",
                "- Preserve the speaker's words, meaning, and order. Never summarize, expand, answer, or add anything they did not say."
            ),
            languageRules("fr")
        )
    }

    @Test
    fun `language table resolves names and labels`() {
        assertEquals("German", Languages.name("de"))
        assertEquals("English", Languages.name(" EN "))
        assertEquals("Portuguese", Languages.name("pt-BR"))
        assertEquals("Chinese", Languages.name("zh_TW"))
        assertNull(Languages.name("auto"))
        assertNull(Languages.name(""))
        assertNull(Languages.name(null))
        assertNull(Languages.name("xx"))
        assertEquals("Auto-detect", Languages.label("auto"))
        assertEquals("Auto-detect", Languages.label(""))
        assertEquals("French", Languages.label("fr"))
        assertEquals("xx", Languages.label("xx"))
        assertEquals(Languages.AUTO to "Auto-detect", Languages.OPTIONS.first())
        assertEquals(Languages.ALL.size + 1, Languages.OPTIONS.size)
        val codes = Languages.ALL.map { it.first }
        assertEquals(codes.size, codes.toSet().size)
        assertTrue(codes.all { Regex("^[a-z]{2}$").matches(it) })
        val names = Languages.ALL.map { it.second }
        assertEquals(names.sorted(), names)
    }

    @Test
    fun `max tokens grows with input but stays bounded`() {
        assertTrue(maxTokensFor("short") >= 768)
        val long = (1..3000).joinToString(" ") { "word" }
        assertEquals(4096, maxTokensFor(long))
    }
}
