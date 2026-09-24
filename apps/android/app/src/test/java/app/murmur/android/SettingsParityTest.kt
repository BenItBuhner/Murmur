package app.murmur.android

import android.content.Context
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsRanges
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.SttPresets
import app.murmur.android.settings.Tone
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

/**
 * The Android side of the cross-platform settings contract
 * (apps/desktop/tests/fixtures/settings-parity.json): the names, defaults and bounds both apps
 * ship for everything a person can set on either, and the speech provider presets. The desktop
 * schema is pinned to the same file by its settings-parity test, so a default changed on one app
 * without the other fails one of the two.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SettingsParityTest {
    private val contract: JSONObject by lazy {
        val file = listOf(
            File("../../../apps/desktop/tests/fixtures/settings-parity.json"),
            File("../../apps/desktop/tests/fixtures/settings-parity.json"),
            File("apps/desktop/tests/fixtures/settings-parity.json")
        ).firstOrNull { it.exists() }
            ?: error("settings-parity.json not found from ${File(".").absolutePath}")
        JSONObject(file.readText())
    }

    private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }
    private fun JSONArray.ints(): List<Int> = (0 until length()).map { getInt(it) }

    @Test
    fun `the defaults are the ones both apps ship`() {
        val d = contract.getJSONObject("defaults")
        val s = MurmurSettings()
        assertEquals(d.getInt("sttTimeoutMs"), s.sttTimeoutMs)
        assertEquals(d.getInt("llmTimeoutMs"), s.llmTimeoutMs)
        assertEquals(d.getBoolean("limitDuration"), s.limitDuration)
        assertEquals(d.getInt("maxDurationSec"), s.maxDurationSec)
        assertEquals(d.getBoolean("keepRecordings"), s.keepRecordings)
        assertEquals(d.getBoolean("useDictionaryPrompt"), s.useDictionaryPrompt)
        assertEquals(d.getBoolean("showLatencyInHistory"), s.showLatencyInHistory)
        assertEquals(d.getBoolean("buttonShadow"), s.buttonShadow)
        assertEquals(d.getString("formattingMode"), s.formattingMode.id)
        assertEquals(d.getString("tone"), s.tone.id)
        assertEquals(d.getBoolean("trailingSpace"), s.trailingSpace)
        assertEquals(d.getString("instructions"), s.llmInstructions)
        assertEquals(d.getString("language"), s.language)
        assertEquals(d.getString("sttKind"), s.sttKind.id)
        assertEquals(d.getString("sttPresetId"), s.sttPresetId)
        assertEquals(d.getBoolean("llmSameAsStt"), s.llmSameAsStt)
        assertEquals(d.getBoolean("updateAutoCheck"), s.updateAutoCheck)
        assertEquals(d.getBoolean("updateAutoInstall"), s.updateAutoInstall)
        assertEquals(d.getBoolean("updateIncludePrereleases"), s.updateIncludePrereleases)
        assertEquals(d.getBoolean("sounds"), s.sounds)
        assertEquals(d.getDouble("soundVolume"), s.soundVolume.toDouble(), 0.0001)
        val k = s.keyboard
        assertEquals(d.getString("overlayPosition"), k.overlayPosition.id)
        assertEquals(d.getBoolean("showOverlayWhenIdle"), k.showOverlayWhenIdle)
        assertEquals(d.getJSONArray("pushToTalk").ints(), k.pushToTalk)
        assertEquals(d.getJSONArray("handsFree").ints(), k.handsFree)
        assertEquals(d.getString("handsFreeTrigger"), k.handsFreeTrigger.id)
        assertEquals(d.getInt("tapThresholdMs"), k.tapThresholdMs)
        assertEquals(d.getInt("doubleTapWindowMs"), k.doubleTapWindowMs)
        assertEquals(d.getBoolean("sideSensitive"), k.sideSensitive)
        assertEquals(d.getBoolean("escapeCancels"), k.escapeCancels)
        // The session cap is off, so a session runs until the user stops it.
        assertNull(s.sessionDurationLimitSec)
        assertEquals(300, s.copy(limitDuration = true).sessionDurationLimitSec)
    }

    @Test
    fun `the bounds are the ones both apps clamp to`() {
        val r = contract.getJSONObject("ranges")
        fun range(name: String): IntRange = r.getJSONObject(name).let { it.getInt("min")..it.getInt("max") }
        assertEquals(range("sttTimeoutMs"), SettingsRanges.STT_TIMEOUT_MS)
        assertEquals(range("llmTimeoutMs"), SettingsRanges.LLM_TIMEOUT_MS)
        assertEquals(range("maxDurationSec"), SettingsRanges.MAX_DURATION_SEC)
    }

    @Test
    fun `the speech provider presets name the same connections`() {
        val expected = contract.getJSONArray("sttPresets")
        assertEquals(expected.length(), SttPresets.ALL.size)
        for (i in 0 until expected.length()) {
            val e = expected.getJSONObject(i)
            val p = SttPresets.ALL[i]
            assertEquals(e.getString("id"), p.id)
            assertEquals(e.getString("kind"), p.kind.id)
            assertEquals(e.getString("baseUrl"), p.baseUrl)
            assertEquals(e.getString("defaultModel"), p.defaultModel)
            assertEquals(e.getJSONArray("models").strings(), p.models)
            assertEquals(e.getBoolean("requiresKey"), p.requiresKey)
            assertEquals(e.getBoolean("local"), p.local)
        }
        assertEquals("an unknown id is Custom", SttPresets.CUSTOM, SttPresets.find("nope").id)
    }

    @Test
    fun `the style vocabularies match`() {
        val rule = contract.getJSONObject("appRule")
        assertEquals(rule.getJSONArray("tones").strings(), Tone.entries.map { it.id })
        assertEquals(rule.getJSONArray("modes").strings(), FormattingMode.entries.map { it.id })
    }

    @Test
    fun `the store clamps a stored value into the bounds instead of running with it`() {
        val context = RuntimeEnvironment.getApplication()
        val prefs = context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE)
        prefs.edit().clear()
            .putInt("sttTimeoutMs", 999_000)
            .putInt("llmTimeoutMs", 250)
            .putInt("maxDurationSec", 0)
            .putInt("parityMigration", 1)
            .commit()
        val store = SettingsStore(context)
        assertEquals(120_000, store.get().sttTimeoutMs)
        assertEquals(1_000, store.get().llmTimeoutMs)
        assertEquals(5, store.get().maxDurationSec)
        // Writes are clamped too, whatever a screen hands over.
        store.update { it.copy(sttTimeoutMs = 1, llmTimeoutMs = 90_000, maxDurationSec = 5_000) }
        assertEquals(2_000, prefs.getInt("sttTimeoutMs", 0))
        assertEquals(60_000, prefs.getInt("llmTimeoutMs", 0))
        assertEquals(1_800, prefs.getInt("maxDurationSec", 0))
    }
}
