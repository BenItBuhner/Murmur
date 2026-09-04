package app.murmur.android

import app.murmur.android.settings.Tone
import app.murmur.android.text.AppCategory
import app.murmur.android.text.AppContext
import app.murmur.android.text.buildFormatMessages
import app.murmur.android.text.maxTokensFor
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
        assertEquals("hello world", messages[1].content)
    }

    @Test
    fun `max tokens grows with input but stays bounded`() {
        assertTrue(maxTokensFor("short") >= 768)
        val long = (1..3000).joinToString(" ") { "word" }
        assertEquals(4096, maxTokensFor(long))
    }
}
