package app.murmur.android

import android.content.Context
import app.murmur.android.settings.SettingsStore
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

private const val GROQ = "https://api.groq.com/openai/v1"
private const val OPENAI = "https://api.openai.com/v1"
private const val PREFS = "murmur_settings"
/** The current generation of the retired-model migration (SettingsStore.MODEL_MIGRATION). */
private const val GENERATION = 2

/**
 * An install that still names a model its provider retired is moved onto the replacement when the
 * store opens, exactly once per generation: after that whatever it names is the user's own choice.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SettingsMigrationTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit()
    }

    private fun seed(vararg pairs: Pair<String, Any>) {
        val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        for ((key, value) in pairs) when (value) {
            is String -> editor.putString(key, value)
            is Boolean -> editor.putBoolean(key, value)
            is Int -> editor.putInt(key, value)
            else -> error("unsupported $value")
        }
        editor.commit()
    }

    @Test
    fun `a store written before the retirement is moved onto the replacement models`() {
        seed(
            "sttSource" to "custom",
            "sttBaseUrl" to GROQ,
            "sttModel" to "distil-whisper-large-v3-en",
            "llmSameAsStt" to true,
            "llmModel" to "llama-3.1-8b-instant"
        )
        val s = SettingsStore(context).get()
        assertEquals("whisper-large-v3-turbo", s.sttModel)
        assertEquals("openai/gpt-oss-20b", s.llmModel)
        assertEquals(GROQ, s.sttBaseUrl)
        // Persisted, and the run is recorded.
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        assertEquals("openai/gpt-oss-20b", prefs.getString("llmModel", null))
        assertEquals(GENERATION, prefs.getInt("modelMigration", 0))
    }

    @Test
    fun `a store from the first generation is moved off the OpenAI transcription models`() {
        // Stamped by a build that knew only the 2026 retirements; whisper-1 and the gpt-4o
        // transcription models shut down on 2027-02-26.
        seed(
            "sttSource" to "custom",
            "sttBaseUrl" to OPENAI,
            "sttModel" to "gpt-4o-mini-transcribe",
            "sttFallbackModel" to "whisper-1",
            "llmSameAsStt" to true,
            "llmModel" to "gpt-4o-mini",
            "modelMigration" to 1
        )
        val s = SettingsStore(context).get()
        assertEquals("gpt-transcribe", s.sttModel)
        assertEquals("gpt-transcribe", s.sttFallbackModel)
        assertEquals("gpt-4o-mini", s.llmModel)
        assertEquals(OPENAI, s.sttBaseUrl)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        assertEquals("gpt-transcribe", prefs.getString("sttModel", null))
        assertEquals(GENERATION, prefs.getInt("modelMigration", 0))
    }

    @Test
    fun `the same ids on another host are left alone`() {
        // whisper-1 is what local servers and proxies answer to; only OpenAI is retiring it.
        seed(
            "sttSource" to "custom",
            "sttBaseUrl" to "http://127.0.0.1:8080/v1",
            "sttModel" to "whisper-1",
            "sttFallbackModel" to "gpt-4o-mini-transcribe",
            "modelMigration" to 1
        )
        val s = SettingsStore(context).get()
        assertEquals("whisper-1", s.sttModel)
        assertEquals("gpt-4o-mini-transcribe", s.sttFallbackModel)
        // The run still counts: it is the table that had nothing to say here.
        assertEquals(GENERATION, context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("modelMigration", 0))
    }

    @Test
    fun `runs once - a retired id chosen after the migration stays`() {
        seed(
            "sttSource" to "custom",
            "sttBaseUrl" to GROQ,
            "sttModel" to "whisper-large-v3-turbo",
            "llmSameAsStt" to true,
            "llmModel" to "llama-3.1-8b-instant",
            "modelMigration" to GENERATION
        )
        assertEquals("llama-3.1-8b-instant", SettingsStore(context).get().llmModel)
        // The same for a retiring speech model on OpenAI's own host.
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit()
        seed(
            "sttSource" to "custom",
            "sttBaseUrl" to OPENAI,
            "sttModel" to "gpt-4o-mini-transcribe",
            "modelMigration" to GENERATION
        )
        assertEquals("gpt-4o-mini-transcribe", SettingsStore(context).get().sttModel)
    }

    @Test
    fun `a fresh install has nothing to move and is simply stamped`() {
        val s = SettingsStore(context).get()
        assertEquals("", s.llmModel)
        assertEquals(GENERATION, context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("modelMigration", 0))
        assertEquals(PARITY_GENERATION, context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("parityMigration", 0))
        assertEquals("the desktop's formatting timeout", 8_000, s.llmTimeoutMs)
    }

    // ---- parity migration: the formatting timeout -----------------------------------------------

    @Test
    fun `an install still on the old 15 s formatting timeout moves to the shared 8 s default once`() {
        // Every earlier build wrote its 15 s default and offered no screen to change it.
        seed("llmTimeoutMs" to 15_000, "sttTimeoutMs" to 45_000, "sttBaseUrl" to GROQ)
        val s = SettingsStore(context).get()
        assertEquals(8_000, s.llmTimeoutMs)
        assertEquals("untouched", 45_000, s.sttTimeoutMs)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        assertEquals(8_000, prefs.getInt("llmTimeoutMs", 0))
        assertEquals(PARITY_GENERATION, prefs.getInt("parityMigration", 0))
    }

    @Test
    fun `runs once - 15 s chosen on the Style screen after the migration stays`() {
        seed("llmTimeoutMs" to 15_000, "parityMigration" to PARITY_GENERATION)
        assertEquals(15_000, SettingsStore(context).get().llmTimeoutMs)
    }

    @Test
    fun `a formatting timeout that is not the old default is the user's and is left alone`() {
        seed("llmTimeoutMs" to 12_000)
        val s = SettingsStore(context).get()
        assertEquals(12_000, s.llmTimeoutMs)
        assertEquals(PARITY_GENERATION, context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("parityMigration", 0))
    }

    @Test
    fun `an install that never wrote a session limit runs unlimited, keeping its old maximum for when it opts in`() {
        // Earlier builds stopped every session at maxDurationSec; the limit is now a choice, off by default.
        seed("maxDurationSec" to 300)
        val s = SettingsStore(context).get()
        assertEquals(false, s.limitDuration)
        assertEquals(300, s.maxDurationSec)
        assertEquals(null, s.sessionDurationLimitSec)
    }
}

/** The current generation of the parity migration (SettingsStore.PARITY_MIGRATION). */
private const val PARITY_GENERATION = 1
