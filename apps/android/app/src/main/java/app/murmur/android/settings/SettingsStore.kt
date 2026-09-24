package app.murmur.android.settings

import android.content.Context
import android.content.SharedPreferences
import app.murmur.android.BuildConfig
import app.murmur.android.overlay.DeviceDisplay
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayDefaults
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayLayoutCodec
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

enum class SttKind(val id: String) {
    OPENAI_COMPATIBLE("openai-compatible"),
    DEEPGRAM("deepgram"),
    ELEVENLABS("elevenlabs");

    companion object {
        fun from(id: String?): SttKind = entries.firstOrNull { it.id == id } ?: OPENAI_COMPATIBLE
    }
}

/**
 * Where a model runs: the Murmur instance's managed models (cloud builds only) or a provider the
 * user configured on this phone. Mirrors `inferenceSourceSchema` in the desktop settings; see
 * app.murmur.android.inference.Inference for how the effective source is decided.
 */
enum class InferenceSource(val id: String) {
    MURMUR("murmur"),
    CUSTOM("custom");

    companion object {
        fun from(id: String?): InferenceSource = entries.firstOrNull { it.id == id } ?: MURMUR
    }
}

/** Serialized by id ("off", "light", "smart") so a stored or synced rule reads like the desktop's. */
@Serializable
enum class FormattingMode(val id: String) {
    @SerialName("off") OFF("off"),
    @SerialName("light") LIGHT("light"),
    @SerialName("smart") SMART("smart");

    companion object {
        fun from(id: String?): FormattingMode = entries.firstOrNull { it.id == id } ?: SMART
    }
}

@Serializable
enum class Tone(val id: String) {
    @SerialName("auto") AUTO("auto"),
    @SerialName("casual") CASUAL("casual"),
    @SerialName("neutral") NEUTRAL("neutral"),
    @SerialName("professional") PROFESSIONAL("professional");

    companion object {
        fun from(id: String?): Tone = entries.firstOrNull { it.id == id } ?: AUTO
    }
}

/**
 * Bounds shared with the desktop schema (apps/desktop/src/shared/settings.ts); a value outside
 * them is clamped when the store reads it and when a screen writes it.
 */
object SettingsRanges {
    /** `stt.timeoutMs`: give up on a transcription after this long. */
    val STT_TIMEOUT_MS: IntRange = 2_000..120_000
    /** `formatting.llm.timeoutMs`: a formatting model slower than this loses to the Light result. */
    val LLM_TIMEOUT_MS: IntRange = 1_000..60_000
    /** `audio.maxDurationSec`: how long a session may run when the limit is on. */
    val MAX_DURATION_SEC: IntRange = 5..1800
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

/** Light, dark, or whatever the system is using. */
enum class ThemeMode(val id: String) {
    SYSTEM("system"),
    LIGHT("light"),
    DARK("dark");

    companion object {
        fun from(id: String?): ThemeMode = entries.firstOrNull { it.id == id } ?: SYSTEM
    }
}

/**
 * Seed colours for the app's own Material 3 palette, used when wallpaper (Material You) colours are
 * unavailable (Android 8 to 11) or turned off. Same seeds as the desktop presets.
 */
enum class AccentPreset(val id: String, val label: String, val seed: Int) {
    CORAL("coral", "Coral", 0xFFFF5A36.toInt()),
    AMBER("amber", "Amber", 0xFFF59E0B.toInt()),
    GREEN("green", "Green", 0xFF2FA84F.toInt()),
    TEAL("teal", "Teal", 0xFF14B8A6.toInt()),
    BLUE("blue", "Blue", 0xFF3B82F6.toInt()),
    INDIGO("indigo", "Indigo", 0xFF6366F1.toInt()),
    VIOLET("violet", "Violet", 0xFF8B5CF6.toInt()),
    PINK("pink", "Pink", 0xFFEC4899.toInt());

    companion object {
        fun from(id: String?): AccentPreset = entries.firstOrNull { it.id == id } ?: CORAL
    }
}

/**
 * Mirror of the desktop settings that matter on Android. Same defaults as the desktop
 * schema in apps/desktop/src/shared/settings.ts, minus desktop-only concerns (hotkeys,
 * injection strategies). The overlay button's shape and spots, and the appearance
 * (theme, wallpaper colours, accent) are device settings (screens and keyboards differ)
 * and are never synced.
 */
data class MurmurSettings(
    /**
     * Managed Murmur models by default in cloud builds; ignored (always the user's own provider) in
     * local builds. The `stt…` and `llm…` connection fields describe the user's own provider only.
     * A build seeded with MURMUR_BASE_URL starts on the seeded provider.
     */
    val sttSource: InferenceSource = if (BuildConfig.DEFAULT_BASE_URL.isBlank()) InferenceSource.MURMUR else InferenceSource.CUSTOM,
    val llmSource: InferenceSource = if (BuildConfig.DEFAULT_BASE_URL.isBlank()) InferenceSource.MURMUR else InferenceSource.CUSTOM,
    val sttKind: SttKind = SttKind.OPENAI_COMPATIBLE,
    val sttBaseUrl: String = BuildConfig.DEFAULT_BASE_URL,
    val sttApiKey: String = BuildConfig.DEFAULT_API_KEY,
    val sttModel: String = BuildConfig.DEFAULT_STT_MODEL,
    val sttFallbackModel: String = "",
    /** The preset the connection was filled from (desktop: `stt.presetId`); `custom` for a hand-typed server. */
    val sttPresetId: String = SttPresets.CUSTOM,
    val language: String = "auto",
    /**
     * Send the dictionary and the snippet triggers to the speech model as its prompt so rare
     * words are spelled right the first time (desktop: `stt.useDictionaryPrompt`). Device-local.
     */
    val useDictionaryPrompt: Boolean = true,
    /** Give up on a transcription after this long; [SettingsRanges.STT_TIMEOUT_MS], same default as the desktop. */
    val sttTimeoutMs: Int = 45_000,
    /**
     * How speech becomes text. The engine (packages/text-engine, ported in app.murmur.android.text)
     * does the language work with the formatting model and adapts to the destination on its own;
     * what is left to choose is whether to use the model, how the result should sound, the trailing
     * space, and anything you want to tell the model.
     */
    val formattingMode: FormattingMode = FormattingMode.SMART,
    val tone: Tone = Tone.AUTO,
    val trailingSpace: Boolean = true,
    /** Free-form guidance for the model ("British spelling", "dates as ISO"). Synced. */
    val llmInstructions: String = "",
    val llmSameAsStt: Boolean = true,
    val llmBaseUrl: String = "",
    val llmApiKey: String = "",
    val llmModel: String = BuildConfig.DEFAULT_LLM_MODEL,
    /**
     * A formatting model slower than this loses to the Light result; [SettingsRanges.LLM_TIMEOUT_MS],
     * same default as the desktop. Builds before the parity pass defaulted to 15 s here with no
     * way to change it; [SettingsStore.migrate] moves those installs to the shared default once.
     */
    val llmTimeoutMs: Int = 8_000,
    /**
     * Sessions run until the user stops them unless this is on (desktop: `audio.limitDuration`).
     * Off by default so a leftover 300 s cap never cuts someone off mid-thought. Device-local.
     */
    val limitDuration: Boolean = false,
    /** Used only when [limitDuration] is on; [SettingsRanges.MAX_DURATION_SEC]. */
    val maxDurationSec: Int = 300,
    /**
     * Store the audio of every dictation next to its History entry (play it back, send it again).
     * Off, only failed dictations keep their audio, and only until they succeed or are deleted.
     */
    val keepRecordings: Boolean = true,
    /**
     * Experimental keyboard support: also type through the Android 13+ accessibility input-method
     * connection, not only accessibility node actions. This is what lands text in apps that take
     * IME input through a custom view but expose no editable accessibility node — terminal
     * emulators above all. Device-local (screens and editors differ); never synced. Off by default;
     * on Android 12 and older it has no effect. Adding it to an already-enabled service can need the
     * service turned off and on once for the input-method flag to take hold.
     */
    val experimentalKeyboard: Boolean = false,
    /**
     * Personal dictionary: STT prompt hint, LLM spelling list and enforced in the text. Synced with
     * the account when signed in (same shape as the desktop app and the backend).
     */
    val dictionaryEntries: List<DictionaryEntry> = emptyList(),
    /**
     * Voice snippets: a spoken trigger expands to stored text after the model, which is told to
     * leave the trigger alone. Synced with the account (same shape as the desktop and the backend).
     */
    val snippets: List<Snippet> = emptyList(),
    /**
     * Per-app style overrides, matched on the focused app's package name or label; the first
     * matching rule wins. Synced with the account (same shape as the desktop and the backend).
     */
    val appRules: List<AppRule> = emptyList(),
    /** Debug aid: dictate the bundled fixture clip instead of the microphone. */
    val useFixtureAudio: Boolean = false,
    /** Resting shape of the floating dictation button. */
    val overlayShape: OverlayShape = OverlayShape.PILL,
    /**
     * The spots the floating button can be parked on (relative to the keyboard), which of them it
     * rests on, and whether they are locked into one row or column. The store starts an install on
     * its device's own default ([SettingsStore.defaultOverlayLayout]); this is the layout when there
     * is no store to ask.
     */
    val overlayLayout: OverlayLayout = OverlayLayout.DEFAULT,
    /** Light, dark or follow the system. */
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    /** Material You: take the palette from the wallpaper (Android 12+). Ignored on older devices. */
    val dynamicColor: Boolean = true,
    /** Seed for Murmur's own palette when wallpaper colours are off or unavailable. */
    val accent: AccentPreset = AccentPreset.CORAL,
    /**
     * The floating dictation button casts a drop shadow and catches the light along its top edge.
     * Off, it and its edit panel are drawn flat: same shape and colours, no shadow, no light catch.
     */
    val buttonShadow: Boolean = true,
    /**
     * Soft cues when recording starts, stops, locks, is cancelled or fails: the desktop's
     * `general.sounds` and `general.soundVolume`, the same synthesized tones. Device-local.
     */
    val sounds: Boolean = true,
    val soundVolume: Float = 0.35f,
    /** A light tap from the vibrator on the same moments (phones and tablets have one; desktops do not). */
    val haptics: Boolean = true,
    /** Per-stage timing bars on Home and in History (desktop: `general.showLatencyInHistory`). Device-local. */
    val showLatencyInHistory: Boolean = true,
    /** Device-level first-run flow finished (permissions, provider). */
    val onboardingComplete: Boolean = false,
    /** `optional` account mode: the user chose to keep using Murmur without an account. */
    val accountSkipped: Boolean = false,
    /** Stable per-install id reported to the account's device list. */
    val deviceId: String = "",
    /** Clerk user id of the last signed-in account (lets the app open offline). */
    val lastSignedInUserId: String = "",
    /** Account whose cloud data absorbed this device's pre-account local dictionary. */
    val importedForUserId: String = "",
    // Device-local update preferences (never synced), same defaults as the desktop app.
    /** Look for new releases when the app opens and daily from the accessibility service. */
    val updateAutoCheck: Boolean = true,
    /** Download new versions and install them once nothing is being dictated. */
    val updateAutoInstall: Boolean = true,
    /** Offer pre-releases (vX.Y.Z-beta.N); always on while running a pre-release build. */
    val updateIncludePrereleases: Boolean = false,
    /** Version the user dismissed; withheld until a newer one appears. */
    val updateSkippedVersion: String = "",
    /** Totals of everything dictated on this phone (see [DictationStats]); never synced as such. */
    val stats: DictationStats = DictationStats.EMPTY,
    /**
     * Hardware-keyboard shortcuts and the desktop-style overlay (see [KeyboardSettings]). One
     * section, stored as one value, so it evolves without touching the rest of the store.
     */
    val keyboard: KeyboardSettings = KeyboardSettings.DEFAULT
) {
    val dictionaryTerms: List<String>
        get() = dictionaryEntries.map { it.word.trim() }.filter { it.isNotEmpty() }

    /** Snippet triggers the speech model is primed with and the formatting model must keep verbatim. */
    val snippetTriggers: List<String>
        get() = snippets.map { it.trigger.trim() }.filter { it.isNotEmpty() }

    /**
     * Seconds until a listening session is force-stopped, or null when the user left the cap off
     * (desktop: `sessionDurationLimitMs`).
     */
    val sessionDurationLimitSec: Int?
        get() = if (limitDuration) maxDurationSec else null

    fun llmConnection(): Triple<String, String, String> =
        if (llmSameAsStt) Triple(sttBaseUrl, sttApiKey, llmModel)
        else Triple(llmBaseUrl, llmApiKey, llmModel)
}

/** Who made a change: the user on this device, or the sync engine mirroring the account. */
enum class SettingsOrigin { LOCAL, CLOUD }

class SettingsStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE)

    /**
     * The spots this device starts with and comes back to on Reset: hand-tuned for a model that
     * was, otherwise laid out from the display's own geometry (see [OverlayDefaults]).
     */
    val defaultOverlayLayout: OverlayLayout = OverlayDefaults.layoutFor(DeviceDisplay.geometry(context))

    private val _flow = MutableStateFlow(read())
    val flow: StateFlow<MurmurSettings> = _flow

    /** Emits (previous, next, origin) for every change so the sync engine can diff local edits. */
    private val listeners = java.util.concurrent.CopyOnWriteArrayList<(MurmurSettings, MurmurSettings, SettingsOrigin) -> Unit>()

    /** Serializes [update]: one read-modify-write-publish at a time. */
    private val updateLock = Any()

    init {
        migrate()
    }

    fun get(): MurmurSettings = _flow.value

    /**
     * Apply [transform] to the current settings and publish the result. Atomic: updates arrive from
     * the UI, the sync engine's scope and the dictation pipeline (stats, right after a dictation
     * lands), and an unsynchronized read-modify-write let a slower one overwrite everything a
     * faster one had just changed. Listeners run inside the same lock so they see every change in
     * the order it was published; none of them blocks.
     */
    fun update(origin: SettingsOrigin = SettingsOrigin.LOCAL, transform: (MurmurSettings) -> MurmurSettings) {
        synchronized(updateLock) {
            val previous = _flow.value
            val next = transform(previous)
            if (next == previous) return
            write(next)
            _flow.value = next
            for (l in listeners) l(previous, next, origin)
        }
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
        // Installs from before model sources existed: one that had connected its own speech provider
        // keeps using it (and its formatting server) instead of being moved to the instance's models.
        if (!prefs.contains("sttSource") && prefs.contains("sttBaseUrl") && _flow.value.sttBaseUrl.isNotBlank()) {
            update(SettingsOrigin.LOCAL) {
                it.copy(
                    sttSource = InferenceSource.CUSTOM,
                    llmSource = if (prefs.contains("llmSource")) it.llmSource else InferenceSource.CUSTOM
                )
            }
        }
        // The rule-based cleanup knobs went away with the text engine; their keys are dead weight.
        val stale = LEGACY_CLEANUP_KEYS.filter { prefs.contains(it) }
        if (stale.isNotEmpty()) prefs.edit().apply { for (k in stale) remove(k) }.apply()
        // Models the hosted providers retired (RetiredModels) are swapped for the recommended
        // replacement once per generation; a store stamped with the current one names the user's
        // own choice, whatever it is.
        if (prefs.getInt(MODEL_MIGRATION_KEY, 0) < MODEL_MIGRATION) {
            update(SettingsOrigin.LOCAL) { RetiredModels.migrate(it) }
            prefs.edit().putInt(MODEL_MIGRATION_KEY, MODEL_MIGRATION).apply()
        }
        // Settings brought into line with the desktop app, once per generation. 1: the formatting
        // timeout defaulted to 15 s here against the desktop's 8 s, and nothing on the phone could
        // change it, so an install still on that value never chose it and takes the shared default.
        // From then on the value is the user's own (the Style screen lets them set it).
        if (prefs.getInt(PARITY_MIGRATION_KEY, 0) < PARITY_MIGRATION) {
            if (prefs.contains("llmTimeoutMs") && prefs.getInt("llmTimeoutMs", 0) == LEGACY_LLM_TIMEOUT_MS) {
                update(SettingsOrigin.LOCAL) { it.copy(llmTimeoutMs = MurmurSettings().llmTimeoutMs) }
            }
            prefs.edit().putInt(PARITY_MIGRATION_KEY, PARITY_MIGRATION).apply()
        }
        if (_flow.value.deviceId.isEmpty()) {
            update(SettingsOrigin.CLOUD) { it.copy(deviceId = java.util.UUID.randomUUID().toString()) }
        }
        // Builds before spots stored one button position; read() already turned it into a layout.
        if (prefs.contains(LEGACY_ANCHOR_X) || prefs.contains(LEGACY_OFFSET_DP)) {
            write(_flow.value)
            prefs.edit().remove(LEGACY_ANCHOR_X).remove(LEGACY_OFFSET_DP).apply()
        }
    }

    /**
     * The stored spots, or [default] (this device's own) when they were never edited. Every write
     * persists the layout whether or not it was touched, so an install still on the spots older
     * builds started with, whichever of them the button rests on, counts as untouched too.
     */
    private fun readOverlayLayout(default: OverlayLayout): OverlayLayout {
        OverlayLayoutCodec.decode(prefs.getString("overlayLayout", null))?.let { stored ->
            return if (stored.isUntouchedLegacyDefault) default else stored
        }
        if (prefs.contains(LEGACY_ANCHOR_X) || prefs.contains(LEGACY_OFFSET_DP)) {
            val legacy = OverlayAnchor(
                xFraction = prefs.getFloat(LEGACY_ANCHOR_X, OverlayAnchor.DEFAULT_X).coerceIn(0f, 1f),
                offsetDp = prefs.getFloat(LEGACY_OFFSET_DP, OverlayAnchor.LEGACY_OFFSET_DP)
            )
            return if (legacy == OverlayAnchor.LEGACY_DEFAULT) default else OverlayLayout.fromLegacy(legacy)
        }
        return default
    }

    private fun read(): MurmurSettings {
        val d = MurmurSettings()
        return MurmurSettings(
            sttSource = InferenceSource.from(prefs.getString("sttSource", d.sttSource.id)),
            llmSource = InferenceSource.from(prefs.getString("llmSource", d.llmSource.id)),
            sttKind = SttKind.from(prefs.getString("sttKind", d.sttKind.id)),
            sttBaseUrl = prefs.getString("sttBaseUrl", d.sttBaseUrl) ?: d.sttBaseUrl,
            sttApiKey = prefs.getString("sttApiKey", d.sttApiKey) ?: d.sttApiKey,
            sttModel = prefs.getString("sttModel", d.sttModel) ?: d.sttModel,
            sttFallbackModel = prefs.getString("sttFallbackModel", d.sttFallbackModel) ?: "",
            sttPresetId = SttPresets.find(prefs.getString("sttPresetId", d.sttPresetId)).id,
            language = prefs.getString("language", d.language) ?: "auto",
            useDictionaryPrompt = prefs.getBoolean("useDictionaryPrompt", d.useDictionaryPrompt),
            sttTimeoutMs = prefs.getInt("sttTimeoutMs", d.sttTimeoutMs).coerceIn(SettingsRanges.STT_TIMEOUT_MS),
            formattingMode = FormattingMode.from(prefs.getString("formattingMode", d.formattingMode.id)),
            tone = Tone.from(prefs.getString("tone", d.tone.id)),
            trailingSpace = prefs.getBoolean("trailingSpace", d.trailingSpace),
            llmInstructions = prefs.getString("llmInstructions", d.llmInstructions) ?: "",
            llmSameAsStt = prefs.getBoolean("llmSameAsStt", d.llmSameAsStt),
            llmBaseUrl = prefs.getString("llmBaseUrl", d.llmBaseUrl) ?: "",
            llmApiKey = prefs.getString("llmApiKey", d.llmApiKey) ?: "",
            llmModel = prefs.getString("llmModel", d.llmModel) ?: d.llmModel,
            llmTimeoutMs = prefs.getInt("llmTimeoutMs", d.llmTimeoutMs).coerceIn(SettingsRanges.LLM_TIMEOUT_MS),
            limitDuration = prefs.getBoolean("limitDuration", d.limitDuration),
            maxDurationSec = prefs.getInt("maxDurationSec", d.maxDurationSec).coerceIn(SettingsRanges.MAX_DURATION_SEC),
            keepRecordings = prefs.getBoolean("keepRecordings", d.keepRecordings),
            experimentalKeyboard = prefs.getBoolean("experimentalKeyboard", d.experimentalKeyboard),
            dictionaryEntries = DictionaryCodec.decode(prefs.getString("dictionaryEntries", null)),
            snippets = SnippetCodec.decode(prefs.getString("snippets", null)),
            appRules = AppRuleCodec.decode(prefs.getString("appRules", null)),
            useFixtureAudio = prefs.getBoolean("useFixtureAudio", d.useFixtureAudio),
            overlayShape = OverlayShape.from(prefs.getString("overlayShape", d.overlayShape.id)),
            overlayLayout = readOverlayLayout(defaultOverlayLayout),
            themeMode = ThemeMode.from(prefs.getString("themeMode", d.themeMode.id)),
            dynamicColor = prefs.getBoolean("dynamicColor", d.dynamicColor),
            accent = AccentPreset.from(prefs.getString("accent", d.accent.id)),
            buttonShadow = prefs.getBoolean("buttonShadow", d.buttonShadow),
            sounds = prefs.getBoolean("sounds", d.sounds),
            soundVolume = prefs.getFloat("soundVolume", d.soundVolume).coerceIn(0f, 1f),
            haptics = prefs.getBoolean("haptics", d.haptics),
            showLatencyInHistory = prefs.getBoolean("showLatencyInHistory", d.showLatencyInHistory),
            onboardingComplete = prefs.getBoolean("onboardingComplete", d.onboardingComplete),
            accountSkipped = prefs.getBoolean("accountSkipped", d.accountSkipped),
            deviceId = prefs.getString("deviceId", d.deviceId) ?: "",
            lastSignedInUserId = prefs.getString("lastSignedInUserId", d.lastSignedInUserId) ?: "",
            importedForUserId = prefs.getString("importedForUserId", d.importedForUserId) ?: "",
            updateAutoCheck = prefs.getBoolean("updateAutoCheck", d.updateAutoCheck),
            updateAutoInstall = prefs.getBoolean("updateAutoInstall", d.updateAutoInstall),
            updateIncludePrereleases = prefs.getBoolean("updateIncludePrereleases", d.updateIncludePrereleases),
            updateSkippedVersion = prefs.getString("updateSkippedVersion", d.updateSkippedVersion) ?: "",
            stats = DictationStats(
                totalWords = prefs.getInt("statsTotalWords", 0),
                totalSessions = prefs.getInt("statsTotalSessions", 0),
                totalSpeechMs = prefs.getLong("statsTotalSpeechMs", 0L),
                streakDays = prefs.getInt("statsStreakDays", 0),
                lastSessionDay = prefs.getString("statsLastSessionDay", "") ?: ""
            ),
            keyboard = KeyboardSettingsCodec.decode(prefs.getString("keyboard", null))
        )
    }

    private fun write(s: MurmurSettings) {
        prefs.edit()
            .putString("sttSource", s.sttSource.id)
            .putString("llmSource", s.llmSource.id)
            .putString("sttKind", s.sttKind.id)
            .putString("sttBaseUrl", s.sttBaseUrl)
            .putString("sttApiKey", s.sttApiKey)
            .putString("sttModel", s.sttModel)
            .putString("sttFallbackModel", s.sttFallbackModel)
            .putString("sttPresetId", s.sttPresetId)
            .putString("language", s.language)
            .putBoolean("useDictionaryPrompt", s.useDictionaryPrompt)
            .putInt("sttTimeoutMs", s.sttTimeoutMs.coerceIn(SettingsRanges.STT_TIMEOUT_MS))
            .putString("formattingMode", s.formattingMode.id)
            .putString("tone", s.tone.id)
            .putBoolean("trailingSpace", s.trailingSpace)
            .putString("llmInstructions", s.llmInstructions)
            .putBoolean("llmSameAsStt", s.llmSameAsStt)
            .putString("llmBaseUrl", s.llmBaseUrl)
            .putString("llmApiKey", s.llmApiKey)
            .putString("llmModel", s.llmModel)
            .putInt("llmTimeoutMs", s.llmTimeoutMs.coerceIn(SettingsRanges.LLM_TIMEOUT_MS))
            .putBoolean("limitDuration", s.limitDuration)
            .putInt("maxDurationSec", s.maxDurationSec.coerceIn(SettingsRanges.MAX_DURATION_SEC))
            .putBoolean("keepRecordings", s.keepRecordings)
            .putBoolean("experimentalKeyboard", s.experimentalKeyboard)
            .putString("dictionaryEntries", DictionaryCodec.encode(s.dictionaryEntries))
            .putString("snippets", SnippetCodec.encode(s.snippets))
            .putString("appRules", AppRuleCodec.encode(s.appRules))
            .putBoolean("useFixtureAudio", s.useFixtureAudio)
            .putString("overlayShape", s.overlayShape.id)
            .putString("overlayLayout", OverlayLayoutCodec.encode(s.overlayLayout))
            .putString("themeMode", s.themeMode.id)
            .putBoolean("dynamicColor", s.dynamicColor)
            .putString("accent", s.accent.id)
            .putBoolean("buttonShadow", s.buttonShadow)
            .putBoolean("sounds", s.sounds)
            .putFloat("soundVolume", s.soundVolume.coerceIn(0f, 1f))
            .putBoolean("haptics", s.haptics)
            .putBoolean("showLatencyInHistory", s.showLatencyInHistory)
            .putBoolean("onboardingComplete", s.onboardingComplete)
            .putBoolean("accountSkipped", s.accountSkipped)
            .putString("deviceId", s.deviceId)
            .putString("lastSignedInUserId", s.lastSignedInUserId)
            .putString("importedForUserId", s.importedForUserId)
            .putBoolean("updateAutoCheck", s.updateAutoCheck)
            .putBoolean("updateAutoInstall", s.updateAutoInstall)
            .putBoolean("updateIncludePrereleases", s.updateIncludePrereleases)
            .putString("updateSkippedVersion", s.updateSkippedVersion)
            .putInt("statsTotalWords", s.stats.totalWords)
            .putInt("statsTotalSessions", s.stats.totalSessions)
            .putLong("statsTotalSpeechMs", s.stats.totalSpeechMs)
            .putInt("statsStreakDays", s.stats.streakDays)
            .putString("statsLastSessionDay", s.stats.lastSessionDay)
            .putString("keyboard", KeyboardSettingsCodec.encode(s.keyboard))
            .apply()
    }

    companion object {
        private const val LEGACY_ANCHOR_X = "overlayAnchorX"
        private const val LEGACY_OFFSET_DP = "overlayOffsetDp"
        /**
         * Bump when RetiredModels gains entries that existing installs should be moved off. The
         * whole table runs again on a store below this generation (same as the desktop settings
         * version). 1: Groq's 2026-08-16 retirements and gpt-4.1-nano; 2: the OpenAI transcription
         * models that shut down on 2027-02-26.
         */
        private const val MODEL_MIGRATION = 2
        private const val MODEL_MIGRATION_KEY = "modelMigration"
        /** Bump when a default is brought into line with the desktop and existing installs should follow. */
        private const val PARITY_MIGRATION = 1
        private const val PARITY_MIGRATION_KEY = "parityMigration"
        /** What `llmTimeoutMs` defaulted to before generation 1, with no screen to change it. */
        private const val LEGACY_LLM_TIMEOUT_MS = 15_000
        private val LEGACY_CLEANUP_KEYS = listOf(
            "removeFillers", "hesitations", "hesitationPhrases", "collapseRepeats", "repetitionScope",
            "spokenCommands", "selfCorrections", "autoCapitalize", "lists", "listStyle", "bulletMarker",
            "numbers", "llmFreedom", "llmStructure", "llmMinWords"
        )

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
