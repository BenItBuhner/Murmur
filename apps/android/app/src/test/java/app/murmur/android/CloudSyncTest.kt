package app.murmur.android

import app.murmur.android.cloud.AccountMode
import app.murmur.android.cloud.AppRuleDto
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.DictionaryEntryDto
import app.murmur.android.cloud.FormattingPreferencesDto
import app.murmur.android.cloud.PreferencesDto
import app.murmur.android.cloud.SnippetDto
import app.murmur.android.cloud.StylePreferences
import app.murmur.android.cloud.SyncOp
import app.murmur.android.cloud.SyncReducers
import app.murmur.android.cloud.applyRemotePreferences
import app.murmur.android.cloud.isAcked
import app.murmur.android.settings.AppRule
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.Snippet
import app.murmur.android.settings.Tone
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure sync rules; the same cases as apps/desktop/tests/cloud-reducers.test.ts. */
class CloudSyncTest {
    private fun remote(id: String, word: String, createdAt: Double = 1.0) =
        DictionaryEntryDto(id, word, emptyList(), false, createdAt, createdAt)

    private fun local(id: String, word: String, createdAt: Long = 1L) =
        DictionaryEntry(id, word, emptyList(), false, createdAt)

    private fun upsert(opId: String, entry: DictionaryEntry, remoteId: String? = null, acked: Boolean = false) =
        SyncOp.DictionaryUpsert(opId, entry.id, remoteId, acked, entry)

    @Test
    fun `config resolution`() {
        val key = "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k"
        assertEquals(AccountMode.OFF, CloudConfig.resolve("", "", "").accountMode)
        assertEquals(AccountMode.REQUIRED, CloudConfig.resolve("https://a.convex.cloud/", key, "").accountMode)
        assertEquals("https://a.convex.cloud", CloudConfig.resolve("https://a.convex.cloud/", key, "").convexUrl)
        assertEquals(AccountMode.OPTIONAL, CloudConfig.resolve("https://a.convex.cloud", key, "optional").accountMode)
        assertEquals(AccountMode.OFF, CloudConfig.resolve("https://a.convex.cloud", key, "off").accountMode)
        assertEquals(AccountMode.OFF, CloudConfig.resolve("https://a.convex.cloud", "not-a-key", "").accountMode)
        assertEquals(AccountMode.OFF, CloudConfig.resolve("ftp://nope", key, "").accountMode)
    }

    @Test
    fun `derive keeps local until the first snapshot then layers pending ops`() {
        val mirror = listOf(local("a", "Alpha"))
        assertEquals(mirror, SyncReducers.deriveDictionary(null, mirror, emptyList()))

        val server = listOf(remote("r1", "Kept", 1.0), remote("r2", "Gone", 2.0))
        val ops = listOf<SyncOp>(
            upsert("op1", local("tmp1", "Added", 9L)),
            SyncOp.DictionaryRemove("op2", "r2")
        )
        val out = SyncReducers.deriveDictionary(server, emptyList(), ops)
        assertEquals(listOf("Added", "Kept"), out.map { it.word })
        assertEquals("tmp1", out[0].id)
    }

    @Test
    fun `acknowledged upserts show under their server id until echoed, then prune`() {
        val acked = upsert("op1", local("tmp1", "Fresh", 3L), remoteId = "r9", acked = true)
        val before = SyncReducers.deriveDictionary(listOf(remote("r1", "Old")), emptyList(), listOf(acked))
        assertEquals(listOf("r9", "r1"), before.map { it.id })
        val after = SyncReducers.deriveDictionary(listOf(remote("r9", "Fresh", 3.0), remote("r1", "Old")), emptyList(), listOf(acked))
        assertEquals(2, after.size)
        assertEquals(1, SyncReducers.pruneAcked(listOf(acked), setOf("other")).size)
        assertEquals(0, SyncReducers.pruneAcked(listOf(acked), setOf("r9")).size)
    }

    @Test
    fun `queue rules`() {
        val a = upsert("op1", local("x", "One"))
        val b = upsert("op2", local("x", "Two"))
        assertEquals(listOf("op2"), SyncReducers.queueUpsert(listOf(a), b).map { it.id })
        val ackedA = upsert("op1", local("x", "One"), "r1", acked = true)
        assertEquals(listOf("op1", "op2"), SyncReducers.queueUpsert(listOf(ackedA), b).map { it.id })

        assertEquals(emptyList<SyncOp>(), SyncReducers.queueRemove(listOf(a), "x", null, "op3"))
        assertEquals(
            listOf<SyncOp>(SyncOp.DictionaryRemove("op4", "r1")),
            SyncReducers.queueRemove(emptyList(), "r1", "r1", "op4")
        )
        assertEquals(
            listOf<SyncOp>(SyncOp.DictionaryRemove("op5", "r7")),
            SyncReducers.queueRemove(listOf(upsert("op1", local("tmp", "Draft"), "r7", true)), "tmp", null, "op5")
        )
        val acked = SyncReducers.ack(listOf(a), "op1", "r1").single() as SyncOp.DictionaryUpsert
        assertTrue(acked.acked)
        assertEquals("r1", acked.remoteId)
    }

    @Test
    fun `diff reports additions changes and removals`() {
        val prev = listOf(local("a", "A"), local("b", "B"), local("c", "C"))
        val next = listOf(local("a", "A"), local("b", "B").copy(fuzzy = true), local("d", "D"))
        val diff = SyncReducers.diffDictionary(prev, next)
        assertEquals(listOf("d"), diff.added.map { it.id })
        assertEquals(listOf("b"), diff.changed.map { it.id })
        assertEquals(listOf("c"), diff.removed.map { it.id })
    }

    @Test
    fun `style preferences patch only what changed and apply remote over local`() {
        val base = StylePreferences.of(MurmurSettings())
        assertEquals(setOf("formatting", "language"), base.patchArgs(null).keys)
        assertEquals(setOf("language"), base.copy(language = "en").patchArgs(base).keys)
        assertEquals(setOf("formatting"), base.copy(tone = "casual").patchArgs(base).keys)
        assertTrue(base.patchArgs(base).isEmpty())

        val applied = applyRemotePreferences(
            MurmurSettings(),
            PreferencesDto(formatting = FormattingPreferencesDto(tone = "professional", mode = "light"), language = "fr")
        )
        assertEquals(Tone.PROFESSIONAL, applied.tone)
        assertEquals(FormattingMode.LIGHT, applied.formattingMode)
        assertEquals("fr", applied.language)
        assertTrue(applied.trailingSpace) // untouched field keeps its local value
        assertEquals("", applied.llmInstructions)
        assertNull(PreferencesDto().formatting)
    }

    // ---- snippets and app rules: the same rules as the dictionary, through the collection spec ----

    private fun snippet(id: String, trigger: String, content: String = "text", createdAt: Long = 1L) = Snippet(id, trigger, content, createdAt)
    private fun rule(id: String, match: String, tone: Tone = Tone.AUTO, formatting: FormattingMode? = null, trailingSpace: Boolean? = null) =
        AppRule(id, match, tone, formatting, trailingSpace, null, 1L)

    @Test
    fun `snippets derive newest first from the server snapshot plus pending ops`() {
        val local = listOf(snippet("l1", "offline"))
        assertEquals("local until the first snapshot", local, SyncReducers.deriveCollection(SyncReducers.snippetsSpec, null, local, emptyList()))
        val server = listOf(SnippetDto("r1", "kept", "k", 1.0, 1.0), SnippetDto("r2", "gone", "g", 2.0, 2.0))
        val ops = listOf<SyncOp>(
            SyncOp.SnippetUpsert("op1", "tmp1", snippet = snippet("tmp1", "added", createdAt = 9L)),
            SyncOp.SnippetRemove("op2", "r2")
        )
        val out = SyncReducers.deriveCollection(SyncReducers.snippetsSpec, server, emptyList(), ops)
        assertEquals(listOf("added", "kept"), out.map { it.trigger })
        assertEquals("tmp1", out[0].id)
        // An edit to a server-known snippet updates it in place under the server id.
        val edited = SyncReducers.deriveCollection(
            SyncReducers.snippetsSpec, server, emptyList(),
            listOf(SyncOp.SnippetUpsert("op3", "r1", remoteId = "r1", snippet = snippet("r1", "kept", "new text")))
        )
        assertEquals("new text", edited.first { it.id == "r1" }.content)
    }

    @Test
    fun `app rules keep the server's order and append local additions`() {
        val server = listOf(
            AppRuleDto("r1", "mail", "professional", createdAt = 2.0, updatedAt = 2.0),
            AppRuleDto("r2", "slack", "casual", formatting = "light", lists = "auto", createdAt = 1.0, updatedAt = 1.0)
        )
        val ops = listOf<SyncOp>(SyncOp.AppRuleUpsert("op1", "tmp", rule = rule("tmp", "terminal", Tone.NEUTRAL, trailingSpace = false)))
        val out = SyncReducers.deriveCollection(SyncReducers.appRulesSpec, server, emptyList(), ops)
        assertEquals(
            listOf(
                AppRule("r1", "mail", Tone.PROFESSIONAL, createdAt = 2L),
                AppRule("r2", "slack", Tone.CASUAL, FormattingMode.LIGHT, createdAt = 1L),
                AppRule("tmp", "terminal", Tone.NEUTRAL, trailingSpace = false, createdAt = 1L)
            ),
            out
        )
        // A changed rule stays where the server had it.
        val changed = SyncReducers.deriveCollection(
            SyncReducers.appRulesSpec, server, emptyList(),
            listOf(SyncOp.AppRuleUpsert("op2", "r1", remoteId = "r1", rule = rule("r1", "mail", Tone.CASUAL)))
        )
        assertEquals(listOf("r1", "r2"), changed.map { it.id })
        assertEquals(Tone.CASUAL, changed[0].tone)
    }

    @Test
    fun `queue, ack and prune treat every collection's upserts alike and never cross collections`() {
        val a = SyncOp.SnippetUpsert("op1", "x", snippet = snippet("x", "one"))
        val b = SyncOp.SnippetUpsert("op2", "x", snippet = snippet("x", "two"))
        assertEquals(listOf("op2"), SyncReducers.queueUpsert(listOf(a), b).map { it.id })
        val acked = SyncReducers.ack(listOf(a), "op1", "r1").single() as SyncOp.SnippetUpsert
        assertTrue(acked.acked)
        assertEquals("r1", acked.remoteId)
        assertTrue(acked.isAcked)
        assertFalse(a.isAcked)
        // Pruned once the snippets snapshot echoes it; the dictionary's ids never touch it.
        assertEquals(1, SyncReducers.pruneAcked(listOf(acked), setOf("d9")).size)
        assertEquals(0, SyncReducers.pruneAcked(listOf(acked), setOf("r1")).size)
        // Removing a never-sent snippet drops its upsert; removing a server one queues its delete.
        assertEquals(emptyList<SyncOp>(), SyncReducers.queueRemove(listOf(a), SyncReducers.snippetsSpec, "x", null, "op3"))
        assertEquals(
            listOf<SyncOp>(SyncOp.SnippetRemove("op4", "r7")),
            SyncReducers.queueRemove(emptyList(), SyncReducers.snippetsSpec, "r7", "r7", "op4")
        )
        assertEquals(
            listOf<SyncOp>(SyncOp.AppRuleRemove("op5", "r8")),
            SyncReducers.queueRemove(listOf(SyncOp.AppRuleUpsert("op1", "tmp", "r8", true, rule("tmp", "m"))), SyncReducers.appRulesSpec, "tmp", null, "op5")
        )
        // A dictionary removal by the same local id leaves a snippet upsert alone.
        val mixed = listOf<SyncOp>(a, SyncOp.DictionaryUpsert("op6", "x", entry = local("x", "Word")))
        assertEquals(listOf("op1"), SyncReducers.queueRemove(mixed, "x", null, "op7").map { it.id })
        assertEquals("r1", SyncReducers.remoteIdFor("x", emptySet(), listOf(acked)))
    }

    @Test
    fun `diff and sameness for snippets and rules`() {
        val prev = listOf(snippet("a", "one"), snippet("b", "two"))
        val next = listOf(snippet("a", "one"), snippet("b", "two", "changed"), snippet("c", "three"))
        val d = SyncReducers.diffCollection(prev, next, { it.id }, SyncReducers::sameSnippet)
        assertEquals(listOf("c"), d.added.map { it.id })
        assertEquals(listOf("b"), d.changed.map { it.id })
        assertTrue(d.removed.isEmpty())
        val r1 = rule("r", "slack", Tone.CASUAL)
        assertTrue(SyncReducers.sameAppRule(r1, r1.copy(createdAt = 99L)))
        assertFalse(SyncReducers.sameAppRule(r1, r1.copy(formatting = FormattingMode.OFF)))
        assertFalse(SyncReducers.sameAppRule(r1, r1.copy(instructions = "x")))
    }

    @Test
    fun `wire arguments carry only what is set, with the desktop's ids`() {
        val full = rule("r", "slack", Tone.CASUAL, FormattingMode.OFF, trailingSpace = false).copy(instructions = "Short.", createdAt = 5L)
        assertEquals(
            mapOf("match" to "slack", "tone" to "casual", "formatting" to "off", "trailingSpace" to false, "instructions" to "Short.", "createdAt" to 5.0),
            CloudSync.appRuleArgs(full)
        )
        // `v.optional` fields are omitted, never null, and a blank instruction is not sent.
        assertEquals(mapOf("match" to "mail", "tone" to "auto"), CloudSync.appRuleArgs(AppRule("r", "mail", instructions = "  ")))
        assertEquals(mapOf("trigger" to "sig", "content" to "Best", "createdAt" to 3.0), CloudSync.snippetArgs(Snippet("s", "sig", "Best", 3L)))
        assertEquals(mapOf("trigger" to "sig", "content" to "Best"), CloudSync.snippetArgs(Snippet("s", "sig", "Best")))
        // A record from the server: legacy knobs older clients wrote are read past and dropped.
        val fromServer = SyncReducers.fromRemote(AppRuleDto("r2", "slack", "casual", formatting = "light", lists = "auto", numbers = "all", freedom = "strict", createdAt = 4.0, updatedAt = 4.0))
        assertEquals(AppRule("r2", "slack", Tone.CASUAL, FormattingMode.LIGHT, createdAt = 4L), fromServer)
    }

    @Test
    fun `the new ops survive the outbox's JSON like the dictionary's`() {
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
        val ops = listOf<SyncOp>(
            SyncOp.DictionaryUpsert("op1", "d", entry = local("d", "Word")),
            SyncOp.SnippetUpsert("op2", "s", remoteId = "r1", acked = true, snippet = snippet("s", "sig", "Best,\nBen")),
            SyncOp.SnippetRemove("op3", "r2"),
            SyncOp.AppRuleUpsert("op4", "a", rule = rule("a", "slack", Tone.CASUAL, FormattingMode.OFF, trailingSpace = true)),
            SyncOp.AppRuleRemove("op5", "r3"),
            SyncOp.PreferencesUpdate("op6", StylePreferences.of(MurmurSettings()))
        )
        val encoded = json.encodeToString(ops)
        assertTrue(encoded, encoded.contains("\"snippets.upsert\"") && encoded.contains("\"appRules.remove\""))
        assertEquals(ops, json.decodeFromString<List<SyncOp>>(encoded))
    }
}
