package app.murmur.android.settings

import android.content.Context
import android.content.SharedPreferences
import app.murmur.android.BuildConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

enum class SttKind(val id: String) {
    OPENAI_COMPATIBLE("openai-compatible"),
    DEEPGRAM("deepgram"),
    ELEVENLABS("elevenlabs");

    companion object {
        fun from(id: String?): SttKind = entries.firstOrNull { it.id == id } ?: OPENAI_COMPATIBLE
    }
}

enum class FormattingMode(val id: String) {
    OFF("off"),
    LIGHT("light"),
    SMART("smart");

    companion object {
        fun from(id: String?): FormattingMode = entries.firstOrNull { it.id == id } ?: SMART
    }
}

enum class Tone(val id: String) {
    AUTO("auto"),
    CASUAL("casual"),
    NEUTRAL("neutral"),
    PROFESSIONAL("professional");

    companion object {
        fun from(id: String?): Tone = entries.firstOrNull { it.id == id } ?: AUTO
    }
}

/** Mirrors of the desktop style enums (apps/desktop/src/shared/settings.ts); ids are the wire values. */
enum class HesitationLevel(val id: String) {
    OFF("off"), LIGHT("light"), THOROUGH("thorough");

    companion object {
        fun from(id: String?): HesitationLevel = entries.firstOrNull { it.id == id } ?: LIGHT
    }
}

enum class RepetitionScope(val id: String) {
    WORDS("words"), PHRASES("phrases"), THOROUGH("thorough");

    companion object {
        fun from(id: String?): RepetitionScope = entries.firstOrNull { it.id == id } ?: PHRASES
    }
}

enum class ListsMode(val id: String) {
    OFF("off"), SPOKEN("spoken"), AUTO("auto");

    companion object {
        fun from(id: String?): ListsMode = entries.firstOrNull { it.id == id } ?: AUTO
    }
}

enum class ListStyle(val id: String) {
    AUTO("auto"), BULLETS("bullets"), NUMBERS("numbers");

    companion object {
        fun from(id: String?): ListStyle = entries.firstOrNull { it.id == id } ?: AUTO
    }
}

enum class BulletMarker(val id: String, val symbol: String) {
    DASH("-", "-"), DOT("•", "•"), STAR("*", "*");

    companion object {
        fun from(id: String?): BulletMarker = entries.firstOrNull { it.id == id } ?: DASH
    }
}

enum class NumbersMode(val id: String) {
    OFF("off"), SMART("smart"), ALL("all");

    companion object {
        fun from(id: String?): NumbersMode = entries.firstOrNull { it.id == id } ?: SMART
    }
}

enum class LlmFreedom(val id: String) {
    STRICT("strict"), BALANCED("balanced"), NATURAL("natural");

    companion object {
        fun from(id: String?): LlmFreedom = entries.firstOrNull { it.id == id } ?: BALANCED
    }
}

enum class LlmStructure(val id: String) {
    KEEP("keep"), ASSIST("assist");

    companion object {
        fun from(id: String?): LlmStructure = entries.firstOrNull { it.id == id } ?: ASSIST
    }
}

/** Resting shape of the floating dictation button. */
enum class OverlayShape(val id: String) {
    /** The classic wide pill (64 x 36 dp). */
    PILL("pill"),
    /** A compact circle (36 dp) small enough to sit on the keyboard's own toolbar row. */
    CIRCLE("circle");

    companion object {
        fun from(id: String?): OverlayShape = entries.firstOrNull { it.id == id } ?: PILL
    }
}

/**
 * Mirror of the desktop settings that matter on Android. Same defaults as the desktop
 * schema in apps/desktop/src/shared/settings.ts, minus desktop-only concerns (hotkeys,
 * injection strategies). The overlay button's shape and position are device settings
 * (screens and keyboards differ) and are never synced.
 */
data class MurmurSettings(
    val sttKind: SttKind = SttKind.OPENAI_COMPATIBLE,
    val sttBaseUrl: String = BuildConfig.DEFAULT_BASE_URL,
    val sttApiKey: String = BuildConfig.DEFAULT_API_KEY,
    val sttModel: String = BuildConfig.DEFAULT_STT_MODEL,
    val sttFallbackModel: String = "",
    val language: String = "auto",
    val sttTimeoutMs: Int = 45_000,
    val formattingMode: FormattingMode = FormattingMode.SMART,
    val tone: Tone = Tone.AUTO,
    val removeFillers: Boolean = true,
    val hesitations: HesitationLevel = HesitationLevel.LIGHT,
    val hesitationPhrases: List<String> = emptyList(),
    val collapseRepeats: Boolean = true,
    val repetitionScope: RepetitionScope = RepetitionScope.PHRASES,
    val spokenCommands: Boolean = true,
    val selfCorrections: Boolean = true,
    val autoCapitalize: Boolean = true,
    val trailingSpace: Boolean = true,
    val lists: ListsMode = ListsMode.AUTO,
    val listStyle: ListStyle = ListStyle.AUTO,
    val bulletMarker: BulletMarker = BulletMarker.DASH,
    val numbers: NumbersMode = NumbersMode.SMART,
    val llmSameAsStt: Boolean = true,
    val llmBaseUrl: String = "",
    val llmApiKey: String = "",
    val llmModel: String = BuildConfig.DEFAULT_LLM_MODEL,
    val llmFreedom: LlmFreedom = LlmFreedom.BALANCED,
    val llmStructure: LlmStructure = LlmStructure.ASSIST,
    val llmInstructions: String = "",
    val llmMinWords: Int = 4,
    // More generous than desktop (8 s): mobile networks and reasoning models need headroom,
    // and the deterministic pipeline still covers any timeout.
    val llmTimeoutMs: Int = 15_000,
    val maxDurationSec: Int = 300,
    /**
     * Personal dictionary: STT prompt hint, LLM spelling list and enforced in the text. Synced with
     * the account when signed in (same shape as the desktop app and the backend).
     */
    val dictionaryEntries: List<DictionaryEntry> = emptyList(),
    /** Debug aid: dictate the bundled fixture clip instead of the microphone. */
    val useFixtureAudio: Boolean = false,
    /** Resting shape of the floating dictation button. */
    val overlayShape: OverlayShape = OverlayShape.PILL,
    /** Horizontal centre of the button as a fraction of the screen width (0 = left, 1 = right). */
    val overlayAnchorX: Float = DEFAULT_OVERLAY_ANCHOR_X,
    /**
     * Vertical position of the button's centre in dp, measured from the top edge of the keyboard.
     * Positive floats above the keyboard; negative sits over it (for example on its toolbar row).
     */
    val overlayOffsetDp: Float = DEFAULT_OVERLAY_OFFSET_DP,
    /** Device-level first-run flow finished (permissions, provider). */
    val onboardingComplete: Boolean = false,
    /** `optional` account mode: the user chose to keep using Murmur without an account. */
    val accountSkipped: Boolean = false,
    /** Stable per-install id reported to the account's device list. */
    val deviceId: String = "",
    /** Clerk user id of the last signed-in account (lets the app open offline). */
    val lastSignedInUserId: String = "",
    /** Account whose cloud data absorbed this device's pre-account local dictionary. */
    val importedForUserId: String = ""
) {
    val dictionaryTerms: List<String>
        get() = dictionaryEntries.map { it.word.trim() }.filter { it.isNotEmpty() }

    fun llmConnection(): Triple<String, String, String> =
        if (llmSameAsStt) Triple(sttBaseUrl, sttApiKey, llmModel)
        else Triple(llmBaseUrl, llmApiKey, llmModel)

    val overlayAtDefaultPosition: Boolean
        get() = overlayAnchorX == DEFAULT_OVERLAY_ANCHOR_X && overlayOffsetDp == DEFAULT_OVERLAY_OFFSET_DP
}

/** Centred above the keyboard. */
const val DEFAULT_OVERLAY_ANCHOR_X = 0.5f

/** A 36 dp button whose bottom edge floats 12 dp above the keyboard: centre = 12 + 36 / 2. */
const val DEFAULT_OVERLAY_OFFSET_DP = 30f

/** Who made a change: the user on this device, or the sync engine mirroring the account. */
enum class SettingsOrigin { LOCAL, CLOUD }

class SettingsStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE)

    private val _flow = MutableStateFlow(read())
    val flow: StateFlow<MurmurSettings> = _flow

    /** Emits (previous, next, origin) for every change so the sync engine can diff local edits. */
    private val listeners = java.util.concurrent.CopyOnWriteArrayList<(MurmurSettings, MurmurSettings, SettingsOrigin) -> Unit>()

    init {
        migrate()
    }

    fun get(): MurmurSettings = _flow.value

    fun update(origin: SettingsOrigin = SettingsOrigin.LOCAL, transform: (MurmurSettings) -> MurmurSettings) {
        val previous = _flow.value
        val next = transform(previous)
        if (next == previous) return
        write(next)
        _flow.value = next
        for (l in listeners) l(previous, next, origin)
    }

    fun update(transform: (MurmurSettings) -> MurmurSettings) = update(SettingsOrigin.LOCAL, transform)

    fun addListener(listener: (MurmurSettings, MurmurSettings, SettingsOrigin) -> Unit) {
        listeners.add(listener)
    }

    fun removeListener(listener: (MurmurSettings, MurmurSettings, SettingsOrigin) -> Unit) {
        listeners.remove(listener)
    }

    /** One-time upgrades of persisted data. */
    private fun migrate() {
        val legacy = prefs.getString("dictionary", null)
        if (!legacy.isNullOrBlank() && !prefs.contains("dictionaryEntries")) {
            val entries = DictionaryCodec.fromLegacy(legacy)
            update(SettingsOrigin.LOCAL) { it.copy(dictionaryEntries = entries) }
            prefs.edit().remove("dictionary").apply()
        }
        if (_flow.value.deviceId.isEmpty()) {
            update(SettingsOrigin.CLOUD) { it.copy(deviceId = java.util.UUID.randomUUID().toString()) }
        }
    }

    private fun read(): MurmurSettings {
        val d = MurmurSettings()
        return MurmurSettings(
            sttKind = SttKind.from(prefs.getString("sttKind", d.sttKind.id)),
            sttBaseUrl = prefs.getString("sttBaseUrl", d.sttBaseUrl) ?: d.sttBaseUrl,
            sttApiKey = prefs.getString("sttApiKey", d.sttApiKey) ?: d.sttApiKey,
            sttModel = prefs.getString("sttModel", d.sttModel) ?: d.sttModel,
            sttFallbackModel = prefs.getString("sttFallbackModel", d.sttFallbackModel) ?: "",
            language = prefs.getString("language", d.language) ?: "auto",
            sttTimeoutMs = prefs.getInt("sttTimeoutMs", d.sttTimeoutMs),
            formattingMode = FormattingMode.from(prefs.getString("formattingMode", d.formattingMode.id)),
            tone = Tone.from(prefs.getString("tone", d.tone.id)),
            removeFillers = prefs.getBoolean("removeFillers", d.removeFillers),
            hesitations = HesitationLevel.from(prefs.getString("hesitations", d.hesitations.id)),
            hesitationPhrases = decodeList(prefs.getString("hesitationPhrases", null)),
            collapseRepeats = prefs.getBoolean("collapseRepeats", d.collapseRepeats),
            repetitionScope = RepetitionScope.from(prefs.getString("repetitionScope", d.repetitionScope.id)),
            spokenCommands = prefs.getBoolean("spokenCommands", d.spokenCommands),
            selfCorrections = prefs.getBoolean("selfCorrections", d.selfCorrections),
            autoCapitalize = prefs.getBoolean("autoCapitalize", d.autoCapitalize),
            trailingSpace = prefs.getBoolean("trailingSpace", d.trailingSpace),
            lists = ListsMode.from(prefs.getString("lists", d.lists.id)),
            listStyle = ListStyle.from(prefs.getString("listStyle", d.listStyle.id)),
            bulletMarker = BulletMarker.from(prefs.getString("bulletMarker", d.bulletMarker.id)),
            numbers = NumbersMode.from(prefs.getString("numbers", d.numbers.id)),
            llmSameAsStt = prefs.getBoolean("llmSameAsStt", d.llmSameAsStt),
            llmBaseUrl = prefs.getString("llmBaseUrl", d.llmBaseUrl) ?: "",
            llmApiKey = prefs.getString("llmApiKey", d.llmApiKey) ?: "",
            llmModel = prefs.getString("llmModel", d.llmModel) ?: d.llmModel,
            llmFreedom = LlmFreedom.from(prefs.getString("llmFreedom", d.llmFreedom.id)),
            llmStructure = LlmStructure.from(prefs.getString("llmStructure", d.llmStructure.id)),
            llmInstructions = prefs.getString("llmInstructions", d.llmInstructions) ?: "",
            llmMinWords = prefs.getInt("llmMinWords", d.llmMinWords),
            llmTimeoutMs = prefs.getInt("llmTimeoutMs", d.llmTimeoutMs),
            maxDurationSec = prefs.getInt("maxDurationSec", d.maxDurationSec),
            dictionaryEntries = DictionaryCodec.decode(prefs.getString("dictionaryEntries", null)),
            useFixtureAudio = prefs.getBoolean("useFixtureAudio", d.useFixtureAudio),
            overlayShape = OverlayShape.from(prefs.getString("overlayShape", d.overlayShape.id)),
            overlayAnchorX = prefs.getFloat("overlayAnchorX", d.overlayAnchorX).coerceIn(0f, 1f),
            overlayOffsetDp = prefs.getFloat("overlayOffsetDp", d.overlayOffsetDp),
            onboardingComplete = prefs.getBoolean("onboardingComplete", d.onboardingComplete),
            accountSkipped = prefs.getBoolean("accountSkipped", d.accountSkipped),
            deviceId = prefs.getString("deviceId", d.deviceId) ?: "",
            lastSignedInUserId = prefs.getString("lastSignedInUserId", d.lastSignedInUserId) ?: "",
            importedForUserId = prefs.getString("importedForUserId", d.importedForUserId) ?: ""
        )
    }

    private fun write(s: MurmurSettings) {
        prefs.edit()
            .putString("sttKind", s.sttKind.id)
            .putString("sttBaseUrl", s.sttBaseUrl)
            .putString("sttApiKey", s.sttApiKey)
            .putString("sttModel", s.sttModel)
            .putString("sttFallbackModel", s.sttFallbackModel)
            .putString("language", s.language)
            .putInt("sttTimeoutMs", s.sttTimeoutMs)
            .putString("formattingMode", s.formattingMode.id)
            .putString("tone", s.tone.id)
            .putBoolean("removeFillers", s.removeFillers)
            .putString("hesitations", s.hesitations.id)
            .putString("hesitationPhrases", encodeList(s.hesitationPhrases))
            .putBoolean("collapseRepeats", s.collapseRepeats)
            .putString("repetitionScope", s.repetitionScope.id)
            .putBoolean("spokenCommands", s.spokenCommands)
            .putBoolean("selfCorrections", s.selfCorrections)
            .putBoolean("autoCapitalize", s.autoCapitalize)
            .putBoolean("trailingSpace", s.trailingSpace)
            .putString("lists", s.lists.id)
            .putString("listStyle", s.listStyle.id)
            .putString("bulletMarker", s.bulletMarker.id)
            .putString("numbers", s.numbers.id)
            .putBoolean("llmSameAsStt", s.llmSameAsStt)
            .putString("llmBaseUrl", s.llmBaseUrl)
            .putString("llmApiKey", s.llmApiKey)
            .putString("llmModel", s.llmModel)
            .putString("llmFreedom", s.llmFreedom.id)
            .putString("llmStructure", s.llmStructure.id)
            .putString("llmInstructions", s.llmInstructions)
            .putInt("llmMinWords", s.llmMinWords)
            .putInt("llmTimeoutMs", s.llmTimeoutMs)
            .putInt("maxDurationSec", s.maxDurationSec)
            .putString("dictionaryEntries", DictionaryCodec.encode(s.dictionaryEntries))
            .putBoolean("useFixtureAudio", s.useFixtureAudio)
            .putString("overlayShape", s.overlayShape.id)
            .putFloat("overlayAnchorX", s.overlayAnchorX)
            .putFloat("overlayOffsetDp", s.overlayOffsetDp)
            .putBoolean("onboardingComplete", s.onboardingComplete)
            .putBoolean("accountSkipped", s.accountSkipped)
            .putString("deviceId", s.deviceId)
            .putString("lastSignedInUserId", s.lastSignedInUserId)
            .putString("importedForUserId", s.importedForUserId)
            .apply()
    }

    companion object {
        @Volatile
        private var instance: SettingsStore? = null

        /** Newline-separated string list; phrases never contain newlines. */
        internal fun encodeList(items: List<String>): String = items.joinToString("\n")
        internal fun decodeList(raw: String?): List<String> =
            raw?.split('\n')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()

        fun get(context: Context): SettingsStore =
            instance ?: synchronized(this) {
                instance ?: SettingsStore(context).also { instance = it }
            }
    }
}
