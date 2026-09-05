package app.murmur.android

import app.murmur.android.cloud.AccountMode
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.DictionaryEntryDto
import app.murmur.android.cloud.FormattingPreferencesDto
import app.murmur.android.cloud.PreferencesDto
import app.murmur.android.cloud.StylePreferences
import app.murmur.android.cloud.SyncOp
import app.murmur.android.cloud.SyncReducers
import app.murmur.android.cloud.applyRemotePreferences
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.Tone
import org.junit.Assert.assertEquals
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
        assertTrue(applied.removeFillers) // untouched field keeps its local value
        assertNull(PreferencesDto().formatting)
    }
}
