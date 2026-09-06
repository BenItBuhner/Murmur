package app.murmur.android

import app.murmur.android.settings.LlmFreedom
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.Tone
import app.murmur.android.text.AppCategory
import app.murmur.android.text.AppContext
import app.murmur.android.text.PipelineOptions
import app.murmur.android.text.buildFormatMessages
import app.murmur.android.text.cleanLlmOutput
import app.murmur.android.text.maxTokensFor
import app.murmur.android.text.resolveStyle
import app.murmur.android.text.runPipeline
import app.murmur.android.text.sanitizeLlmOutput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    fun `max tokens grows with input but stays bounded`() {
        assertTrue(maxTokensFor("short") >= 768)
        val long = (1..3000).joinToString(" ") { "word" }
        assertEquals(4096, maxTokensFor(long))
    }
}
