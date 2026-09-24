package app.murmur.android

import app.murmur.android.settings.AppRule
import app.murmur.android.settings.AppRuleCodec
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.Snippet
import app.murmur.android.settings.SnippetCodec
import app.murmur.android.settings.Tone
import app.murmur.android.text.AppCategory
import app.murmur.android.text.AppContext
import app.murmur.android.text.SnippetContext
import app.murmur.android.text.classifyPackage
import app.murmur.android.text.expandSnippets
import app.murmur.android.text.fillPlaceholders
import app.murmur.android.text.findRule
import app.murmur.android.text.finish
import app.murmur.android.text.resolveStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The two text features the phone gained for parity with the desktop: voice snippets (port of
 * packages/text-engine/src/snippets.ts, expanded after the model) and per-app style rules (port of
 * `resolveStyle` in context.ts). Same cases as the engine's own tests.
 */
class SnippetsAndRulesTest {
    private fun snippet(trigger: String, content: String) = Snippet("id-$trigger", trigger, content, 1L)

    private val fixedNow: Date = Calendar.getInstance(TimeZone.getTimeZone("UTC"), Locale.US).apply {
        clear()
        set(2026, Calendar.SEPTEMBER, 24, 16, 5, 0)
    }.time
    private val ctx = SnippetContext(now = fixedNow, clipboard = "from the clipboard", locale = Locale.US)

    // ---- snippets ---------------------------------------------------------------------------------

    @Test
    fun `finish expands a snippet after the model and keeps its content verbatim`() {
        val f = finish("sign off with my sig", AppCategory.CHAT, emptyList(), trailingSpace = true, snippets = listOf(snippet("my sig", "Best,\nBen")))
        assertEquals("sign off with Best,\nBen ", f.text)
        assertEquals(listOf("snippets"), f.stages)
        assertEquals(listOf("my sig"), f.snippetsExpanded)
    }

    @Test
    fun `a trigger may be prefixed with insert, paste or snippet and carry the transcriber's punctuation`() {
        val snippets = listOf(snippet("my email", "ben@example.com"))
        assertEquals("Reach me at ben@example.com", expandSnippets("Reach me at insert my email.", snippets, ctx).text)
        assertEquals("Reach me at ben@example.com", expandSnippets("Reach me at paste my email,", snippets, ctx).text)
        assertEquals("Reach me at ben@example.com", expandSnippets("Reach me at Snippet My Email", snippets, ctx).text)
        // Spaces inside the trigger may come back any way the transcriber splits them.
        assertEquals("ben@example.com", expandSnippets("my  email", snippets, ctx).text)
    }

    @Test
    fun `a trigger only matches whole words and the longest trigger wins`() {
        val snippets = listOf(snippet("sig", "SHORT"), snippet("work sig", "LONG"))
        assertEquals("my signature stays", expandSnippets("my signature stays", snippets, ctx).text)
        val out = expandSnippets("use work sig here", snippets, ctx)
        assertEquals("use LONG here", out.text)
        assertEquals(listOf("work sig"), out.expanded)
        assertEquals("nothing to do", "hello", expandSnippets("hello", emptyList(), ctx).text)
        assertTrue(expandSnippets("hello", listOf(snippet("  ", "x")), ctx).expanded.isEmpty())
    }

    @Test
    fun `placeholders are filled from the moment of insertion on this device`() {
        val filled = fillPlaceholders("{date} | {time} | {day} | {DateTime} | {clipboard}", ctx.copy(locale = Locale.US))
        val parts = filled.split(" | ")
        assertEquals(5, parts.size)
        // Locale-formatted like the desktop's toLocaleDateString / toLocaleTimeString; the wall
        // clock is the test machine's zone, so only the date and weekday are pinned to a value.
        assertTrue(parts[0], parts[0].contains("2026"))
        assertTrue(parts[1], Regex("\\d{1,2}:\\d{2}").containsMatchIn(parts[1]))
        assertTrue(parts[2], parts[2].isNotBlank())
        assertTrue(parts[3], parts[3].contains("26") || parts[3].contains("2026"))
        assertEquals("from the clipboard", parts[4])
        assertEquals("no clipboard, no text", "a  b", fillPlaceholders("a {clipboard} b", ctx.copy(clipboard = null)))
    }

    @Test
    fun `snippets survive the round trip through the store's codec and never carry a blank trigger`() {
        val list = listOf(snippet("my sig", "Best,\nBen"), snippet("addr", "1 Main St\n\nSuite 2"))
        assertEquals(list, SnippetCodec.decode(SnippetCodec.encode(list)))
        assertEquals(emptyList<Snippet>(), SnippetCodec.decode(null))
        assertEquals(emptyList<Snippet>(), SnippetCodec.decode("not json"))
        assertEquals(1, SnippetCodec.decode("""[{"id":"a","trigger":" ","content":"x"},{"id":"b","trigger":"ok","content":"y"}]""").size)
        val fresh = SnippetCodec.newSnippet("  my sig ", "Best")
        assertEquals("my sig", fresh.trigger)
        assertTrue(fresh.createdAt > 0)
    }

    // ---- per-app rules ----------------------------------------------------------------------------

    private val base = MurmurSettings(formattingMode = FormattingMode.SMART, tone = Tone.AUTO, trailingSpace = true, llmInstructions = "Use British spelling.")
    private fun rule(match: String, tone: Tone = Tone.AUTO, formatting: FormattingMode? = null, trailingSpace: Boolean? = null, instructions: String? = null) =
        AppRule("r-$match", match, tone, formatting, trailingSpace, instructions, 1L)

    @Test
    fun `without a matching rule the global settings and the destination's defaults apply`() {
        val style = resolveStyle(base.copy(appRules = listOf(rule("slack", Tone.CASUAL))), classifyPackage("com.google.android.gm", "Gmail"))
        assertEquals(Tone.PROFESSIONAL, style.tone)
        assertEquals(FormattingMode.SMART, style.mode)
        assertEquals("Use British spelling.", style.instructions)
        assertEquals(true, style.trailingSpace)
        assertNull(style.rule)
    }

    @Test
    fun `a rule matches on the package name or the app's label, the first matching rule wins`() {
        val rules = listOf(rule("whatsapp", Tone.PROFESSIONAL), rule("gmail", formatting = FormattingMode.OFF), rule("mail", Tone.CASUAL))
        assertEquals("whatsapp", findRule(rules, AppContext("com.whatsapp", AppCategory.CHAT))?.match)
        // The label reaches a rule the package name would not ("Gmail" for com.google.android.gm).
        val gmail = classifyPackage("com.google.android.gm", "Gmail")
        assertEquals("gmail", findRule(rules, gmail)?.match)
        assertEquals("case-insensitive", "mail", findRule(listOf(rule("MAIL")), AppContext("com.fastmail.app", AppCategory.EMAIL))?.match?.lowercase())
        assertNull("a blank match never applies", findRule(listOf(rule("  ")), gmail))
        assertNull(findRule(rules, AppContext("org.telegram.messenger", AppCategory.CHAT, "Telegram")))
    }

    @Test
    fun `a rule overrides what it sets and inherits the rest, its instructions appended to the global ones`() {
        val s = base.copy(appRules = listOf(rule("whatsapp", Tone.PROFESSIONAL, FormattingMode.LIGHT, trailingSpace = false, instructions = "One short paragraph.")))
        val style = resolveStyle(s, classifyPackage("com.whatsapp", "WhatsApp"))
        assertEquals(Tone.PROFESSIONAL, style.tone)
        assertEquals(FormattingMode.LIGHT, style.mode)
        assertEquals(false, style.trailingSpace)
        assertEquals("Use British spelling.\n\nOne short paragraph.", style.instructions)
        assertEquals("whatsapp", style.rule?.match)
    }

    @Test
    fun `a rule that leaves the tone on Default falls through to the global tone, then to the destination`() {
        val chat = classifyPackage("com.whatsapp", "WhatsApp")
        val inherit = base.copy(appRules = listOf(rule("whatsapp", formatting = FormattingMode.OFF)))
        assertEquals(Tone.CASUAL, resolveStyle(inherit, chat).tone)
        assertEquals(FormattingMode.OFF, resolveStyle(inherit, chat).mode)
        assertEquals(Tone.NEUTRAL, resolveStyle(inherit.copy(tone = Tone.NEUTRAL), chat).tone)
        // Only the global instructions, with no stray separator, when the rule has none.
        assertEquals("Use British spelling.", resolveStyle(inherit, chat).instructions)
        assertEquals("", resolveStyle(inherit.copy(llmInstructions = ""), chat).instructions)
    }

    @Test
    fun `rules survive the round trip through the store's codec with their optional fields`() {
        val rules = listOf(
            rule("slack", Tone.CASUAL),
            rule("Code", formatting = FormattingMode.OFF, trailingSpace = false, instructions = "Keep identifiers.")
        )
        val decoded = AppRuleCodec.decode(AppRuleCodec.encode(rules))
        assertEquals(rules, decoded)
        assertNull(decoded[0].formatting)
        assertEquals(FormattingMode.OFF, decoded[1].formatting)
        // The ids on the wire are the desktop's, so a record written by either app reads on the other.
        assertTrue(AppRuleCodec.encode(rules).contains("\"formatting\":\"off\""))
        assertTrue(AppRuleCodec.encode(rules).contains("\"tone\":\"casual\""))
        assertEquals(emptyList<AppRule>(), AppRuleCodec.decode("nope"))
        assertEquals("", AppRuleCodec.newRule().match)
    }
}
