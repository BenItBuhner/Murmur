package app.murmur.android.cloud

import android.content.Context
import android.content.SharedPreferences
import app.murmur.android.settings.BulletMarker
import app.murmur.android.settings.DictationStats
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.HesitationLevel
import app.murmur.android.settings.ListStyle
import app.murmur.android.settings.ListsMode
import app.murmur.android.settings.LlmFreedom
import app.murmur.android.settings.LlmStructure
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.NumbersMode
import app.murmur.android.settings.RepetitionScope
import app.murmur.android.settings.Tone
import java.util.UUID
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/*
 * Wire shapes returned by packages/backend. Convex `v.number()` values are JS doubles, so every
 * numeric field is a Double here (and every numeric argument sent back must be a Double too:
 * Kotlin Int/Long would be encoded as Convex int64 and fail validation).
 */

@Serializable
data class DictionaryEntryDto(
    val id: String,
    val word: String,
    val aliases: List<String> = emptyList(),
    val fuzzy: Boolean = false,
    val createdAt: Double = 0.0,
    val updatedAt: Double = 0.0
)

@Serializable
data class UserDto(
    val id: String,
    val clerkId: String,
    val email: String? = null,
    val name: String? = null,
    val imageUrl: String? = null,
    /** Account tier (`free` or `pro`), deciding the managed-inference allowance. */
    val plan: String = "free",
    val onboardingCompletedAt: Double? = null,
    val onboardingVersion: Double? = null,
    val createdAt: Double = 0.0
)

@Serializable
data class InferenceModelsDto(val stt: String? = null, val llm: String? = null)

@Serializable
data class InferenceLimitsDto(
    val sttSecondsPerMonth: Double = 0.0,
    val llmTokensPerMonth: Double = 0.0,
    val requestsPerMinute: Double = 0.0,
    val maxClipSeconds: Double = 0.0
)

@Serializable
data class InferenceUsageDto(
    /** Newest month with any usage (`YYYY-MM`, UTC); other months count as zero. */
    val period: String = "",
    val sttSeconds: Double = 0.0,
    val sttRequests: Double = 0.0,
    val llmTokens: Double = 0.0,
    val llmRequests: Double = 0.0
)

/** What the instance offers the signed-in account in managed models, and how much is left (`inference:status`). */
@Serializable
data class InferenceStatusDto(
    /** The instance is configured with at least a managed speech model. */
    val available: Boolean = false,
    val models: InferenceModelsDto = InferenceModelsDto(),
    val plan: String = "free",
    val limits: InferenceLimitsDto = InferenceLimitsDto(),
    val usage: InferenceUsageDto = InferenceUsageDto()
) {
    /** Managed speech seconds used in [period], zero for any other month. */
    fun sttSecondsIn(period: String): Double = if (usage.period == period) usage.sttSeconds else 0.0

    fun llmTokensIn(period: String): Double = if (usage.period == period) usage.llmTokens else 0.0

    companion object {
        /** Current UTC month as `YYYY-MM`, the period the gateway bills usage to. */
        fun currentPeriod(now: Long = System.currentTimeMillis()): String {
            val cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"))
            cal.timeInMillis = now
            return "%04d-%02d".format(cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH) + 1)
        }
    }
}

@Serializable
data class DeviceDto(
    val id: String,
    val deviceId: String,
    val name: String,
    val platform: String,
    val appVersion: String,
    val lastSeenAt: Double,
    val createdAt: Double
)

@Serializable
data class FormattingPreferencesDto(
    val mode: String? = null,
    val tone: String? = null,
    val removeFillers: Boolean? = null,
    val fillerWords: List<String>? = null,
    val hesitations: String? = null,
    val hesitationPhrases: List<String>? = null,
    val collapseRepeats: Boolean? = null,
    val repetitionScope: String? = null,
    val spokenCommands: Boolean? = null,
    val selfCorrections: Boolean? = null,
    val autoCapitalize: Boolean? = null,
    val trailingSpace: Boolean? = null,
    val pressEnterCommand: Boolean? = null,
    val lists: String? = null,
    val listStyle: String? = null,
    val bulletMarker: String? = null,
    val numbers: String? = null,
    val llmFreedom: String? = null,
    val llmStructure: String? = null,
    val llmInstructions: String? = null
)

@Serializable
data class SyncPreferencesDto(val history: Boolean? = null)

/** The account's dictation totals across every device (`stats:get`). */
@Serializable
data class StatsDto(
    val totalWords: Double = 0.0,
    val totalSessions: Double = 0.0,
    val totalSpeechMs: Double = 0.0,
    val streakDays: Double = 0.0,
    val lastSessionDay: String = "",
    val updatedAt: Double = 0.0
)

@Serializable
data class PreferencesDto(
    val formatting: FormattingPreferencesDto? = null,
    val language: String? = null,
    val sync: SyncPreferencesDto? = null,
    val updatedAt: Double = 0.0
)

/** Style preferences this app knows about; the subset of the account's preferences it syncs. */
@Serializable
data class StylePreferences(
    val mode: String,
    val tone: String,
    val removeFillers: Boolean,
    val collapseRepeats: Boolean,
    val spokenCommands: Boolean,
    val selfCorrections: Boolean,
    val autoCapitalize: Boolean,
    val trailingSpace: Boolean,
    val language: String,
    // Added with the structured-cleanup release; defaults keep older persisted outbox entries decodable.
    val hesitations: String = HesitationLevel.LIGHT.id,
    val hesitationPhrases: List<String> = emptyList(),
    val repetitionScope: String = RepetitionScope.PHRASES.id,
    val lists: String = ListsMode.AUTO.id,
    val listStyle: String = ListStyle.AUTO.id,
    val bulletMarker: String = BulletMarker.DASH.id,
    val numbers: String = NumbersMode.SMART.id,
    val llmFreedom: String = LlmFreedom.BALANCED.id,
    val llmStructure: String = LlmStructure.ASSIST.id,
    val llmInstructions: String = ""
) {
    companion object {
        fun of(s: MurmurSettings) = StylePreferences(
            mode = s.formattingMode.id,
            tone = s.tone.id,
            removeFillers = s.removeFillers,
            collapseRepeats = s.collapseRepeats,
            spokenCommands = s.spokenCommands,
            selfCorrections = s.selfCorrections,
            autoCapitalize = s.autoCapitalize,
            trailingSpace = s.trailingSpace,
            language = s.language,
            hesitations = s.hesitations.id,
            hesitationPhrases = s.hesitationPhrases,
            repetitionScope = s.repetitionScope.id,
            lists = s.lists.id,
            listStyle = s.listStyle.id,
            bulletMarker = s.bulletMarker.id,
            numbers = s.numbers.id,
            llmFreedom = s.llmFreedom.id,
            llmStructure = s.llmStructure.id,
            llmInstructions = s.llmInstructions
        )
    }

    /** Mutation arguments for `preferences:update`; only the sections that differ from [previous]. */
    fun patchArgs(previous: StylePreferences?): Map<String, Any?> {
        val formatting = mapOf(
            "mode" to mode,
            "tone" to tone,
            "removeFillers" to removeFillers,
            "collapseRepeats" to collapseRepeats,
            "spokenCommands" to spokenCommands,
            "selfCorrections" to selfCorrections,
            "autoCapitalize" to autoCapitalize,
            "trailingSpace" to trailingSpace,
            "hesitations" to hesitations,
            "hesitationPhrases" to hesitationPhrases,
            "repetitionScope" to repetitionScope,
            "lists" to lists,
            "listStyle" to listStyle,
            "bulletMarker" to bulletMarker,
            "numbers" to numbers,
            "llmFreedom" to llmFreedom,
            "llmStructure" to llmStructure,
            "llmInstructions" to llmInstructions
        )
        val args = LinkedHashMap<String, Any?>()
        if (previous == null || previous.copy(language = language) != this) args["formatting"] = formatting
        if (previous == null || previous.language != language) args["language"] = language
        return args
    }
}

/** Apply the account's preferences over local settings; fields the server never saw keep local values. */
fun applyRemotePreferences(s: MurmurSettings, remote: PreferencesDto): MurmurSettings {
    val f = remote.formatting
    return s.copy(
        formattingMode = f?.mode?.let { FormattingMode.from(it) } ?: s.formattingMode,
        tone = f?.tone?.let { Tone.from(it) } ?: s.tone,
        removeFillers = f?.removeFillers ?: s.removeFillers,
        collapseRepeats = f?.collapseRepeats ?: s.collapseRepeats,
        spokenCommands = f?.spokenCommands ?: s.spokenCommands,
        selfCorrections = f?.selfCorrections ?: s.selfCorrections,
        autoCapitalize = f?.autoCapitalize ?: s.autoCapitalize,
        trailingSpace = f?.trailingSpace ?: s.trailingSpace,
        hesitations = f?.hesitations?.let { HesitationLevel.from(it) } ?: s.hesitations,
        hesitationPhrases = f?.hesitationPhrases ?: s.hesitationPhrases,
        repetitionScope = f?.repetitionScope?.let { RepetitionScope.from(it) } ?: s.repetitionScope,
        lists = f?.lists?.let { ListsMode.from(it) } ?: s.lists,
        listStyle = f?.listStyle?.let { ListStyle.from(it) } ?: s.listStyle,
        bulletMarker = f?.bulletMarker?.let { BulletMarker.from(it) } ?: s.bulletMarker,
        numbers = f?.numbers?.let { NumbersMode.from(it) } ?: s.numbers,
        llmFreedom = f?.llmFreedom?.let { LlmFreedom.from(it) } ?: s.llmFreedom,
        llmStructure = f?.llmStructure?.let { LlmStructure.from(it) } ?: s.llmStructure,
        llmInstructions = f?.llmInstructions ?: s.llmInstructions,
        language = remote.language ?: s.language
    )
}

// ---- outbox ----------------------------------------------------------------------------------

/** A local change waiting for the server. Every op is idempotent on the backend. */
@Serializable
sealed class SyncOp {
    abstract val id: String

    @Serializable
    @SerialName("dictionary.upsert")
    data class DictionaryUpsert(
        override val id: String,
        val localId: String,
        val remoteId: String? = null,
        val acked: Boolean = false,
        val entry: DictionaryEntry
    ) : SyncOp()

    @Serializable
    @SerialName("dictionary.remove")
    data class DictionaryRemove(override val id: String, val remoteId: String) : SyncOp()

    @Serializable
    @SerialName("preferences.update")
    data class PreferencesUpdate(override val id: String, val prefs: StylePreferences) : SyncOp()

    @Serializable
    @SerialName("stats.record")
    data class StatsRecord(
        override val id: String,
        val sessionId: String,
        val words: Int,
        val speechMs: Long,
        val day: String
    ) : SyncOp()

    @Serializable
    @SerialName("users.completeOnboarding")
    data class CompleteOnboarding(override val id: String) : SyncOp()
}

fun newOpId(): String = UUID.randomUUID().toString()

/** Durable queue in SharedPreferences, bound to one account. */
class Outbox(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("murmur_sync_outbox", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    @Volatile
    var ops: List<SyncOp> = load()
        private set

    val userId: String get() = prefs.getString("userId", "") ?: ""

    val pending: Int get() = ops.count { !(it is SyncOp.DictionaryUpsert && it.acked) }

    fun bind(userId: String) {
        if (this.userId != userId) {
            prefs.edit().putString("userId", userId).putString("ops", "[]").apply()
            ops = emptyList()
        }
    }

    @Synchronized
    fun update(fn: (List<SyncOp>) -> List<SyncOp>) {
        val next = fn(ops)
        ops = next
        prefs.edit().putString("ops", json.encodeToString(next)).apply()
    }

    fun remove(opId: String) = update { list -> list.filter { it.id != opId } }

    fun clear() {
        ops = emptyList()
        prefs.edit().putString("userId", "").putString("ops", "[]").apply()
    }

    private fun load(): List<SyncOp> = try {
        json.decodeFromString<List<SyncOp>>(prefs.getString("ops", null) ?: "[]")
    } catch (_: Exception) {
        emptyList()
    }
}

// ---- reducers (pure; see SyncReducersTest) ----------------------------------------------------

object SyncReducers {
    fun fromRemote(dto: DictionaryEntryDto) = DictionaryEntry(
        id = dto.id,
        word = dto.word,
        aliases = dto.aliases,
        fuzzy = dto.fuzzy,
        createdAt = dto.createdAt.toLong()
    )

    /** Server snapshot + pending ops -> the list the app shows. Local is kept until the first snapshot. */
    fun deriveDictionary(
        server: List<DictionaryEntryDto>?,
        local: List<DictionaryEntry>,
        ops: List<SyncOp>
    ): List<DictionaryEntry> {
        if (server == null) return local
        val byId = LinkedHashMap<String, DictionaryEntry>()
        for (dto in server) byId[dto.id] = fromRemote(dto)
        val serverIds = server.map { it.id }.toSet()
        for (op in ops) {
            when (op) {
                is SyncOp.DictionaryUpsert -> {
                    if (op.acked && op.remoteId != null && serverIds.contains(op.remoteId)) continue
                    val id = op.remoteId ?: op.localId
                    if (op.remoteId != null && op.remoteId != op.localId) byId.remove(op.localId)
                    byId[id] = op.entry.copy(id = id)
                }
                is SyncOp.DictionaryRemove -> byId.remove(op.remoteId)
                else -> Unit
            }
        }
        return byId.values.sortedByDescending { it.createdAt }
    }

    data class Diff(val added: List<DictionaryEntry>, val changed: List<DictionaryEntry>, val removed: List<DictionaryEntry>)

    fun diffDictionary(previous: List<DictionaryEntry>, next: List<DictionaryEntry>): Diff {
        val prevById = previous.associateBy { it.id }
        val nextIds = next.map { it.id }.toSet()
        val added = ArrayList<DictionaryEntry>()
        val changed = ArrayList<DictionaryEntry>()
        for (e in next) {
            val before = prevById[e.id]
            if (before == null) added.add(e)
            else if (before.word != e.word || before.fuzzy != e.fuzzy || before.aliases != e.aliases) changed.add(e)
        }
        return Diff(added, changed, previous.filter { it.id !in nextIds })
    }

    /** Replace an unsent upsert for the same item; keep acknowledged ones. */
    fun queueUpsert(ops: List<SyncOp>, op: SyncOp.DictionaryUpsert): List<SyncOp> =
        ops.filterNot { it is SyncOp.DictionaryUpsert && it.localId == op.localId && !it.acked } + op

    /** Drop a never-sent creation outright; otherwise delete the server record. */
    fun queueRemove(ops: List<SyncOp>, localId: String, remoteId: String?, opId: String): List<SyncOp> {
        val pending = ops.filterIsInstance<SyncOp.DictionaryUpsert>().firstOrNull { it.localId == localId }
        val target = remoteId ?: pending?.remoteId
        val kept = ops.filterNot { it is SyncOp.DictionaryUpsert && it.localId == localId }
        return if (target == null) kept else kept + SyncOp.DictionaryRemove(opId, target)
    }

    fun ack(ops: List<SyncOp>, opId: String, remoteId: String): List<SyncOp> =
        ops.map { if (it is SyncOp.DictionaryUpsert && it.id == opId) it.copy(remoteId = remoteId, acked = true) else it }

    fun pruneAcked(ops: List<SyncOp>, serverIds: Set<String>): List<SyncOp> =
        ops.filterNot { it is SyncOp.DictionaryUpsert && it.acked && it.remoteId != null && serverIds.contains(it.remoteId) }

    /** Coalesce style changes into one pending update carrying the latest full preferences. */
    fun queuePreferences(ops: List<SyncOp>, prefs: StylePreferences, opId: String): List<SyncOp> =
        ops.filterNot { it is SyncOp.PreferencesUpdate } + SyncOp.PreferencesUpdate(opId, prefs)

    fun remoteIdFor(localId: String, serverIds: Set<String>, ops: List<SyncOp>): String? {
        if (serverIds.contains(localId)) return localId
        return ops.filterIsInstance<SyncOp.DictionaryUpsert>().firstOrNull { it.localId == localId }?.remoteId
    }

    /**
     * The totals to show while signed in: the account's numbers plus the dictations still waiting
     * in the outbox, so a session counts the moment it is finished and is not counted twice once
     * the server has it. Same rule as the desktop's `deriveStats`. Without a server snapshot the
     * device's own totals stand.
     */
    fun deriveStats(local: DictationStats, server: StatsDto?, ops: List<SyncOp>): DictationStats {
        if (server == null) return local
        val pending = ops.filterIsInstance<SyncOp.StatsRecord>()
        var out = DictationStats(
            totalWords = server.totalWords.toInt(),
            totalSessions = server.totalSessions.toInt(),
            totalSpeechMs = server.totalSpeechMs.toLong(),
            streakDays = maxOf(server.streakDays.toInt(), if (pending.isNotEmpty()) local.streakDays else 0),
            lastSessionDay = if (pending.isNotEmpty() && local.lastSessionDay > server.lastSessionDay) local.lastSessionDay else server.lastSessionDay
        )
        for (op in pending) {
            out = out.copy(
                totalWords = out.totalWords + op.words,
                totalSessions = out.totalSessions + 1,
                totalSpeechMs = out.totalSpeechMs + op.speechMs
            )
        }
        return out
    }
}
