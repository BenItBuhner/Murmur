package app.murmur.android

import android.content.Context
import android.os.SystemClock
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.VibrationEffect.Composition.PRIMITIVE_CLICK
import android.os.VibrationEffect.Composition.PRIMITIVE_TICK
import android.os.Vibrator
import android.os.VibratorManager
import app.murmur.android.dictation.Haptic
import app.murmur.android.dictation.HapticPatterns
import app.murmur.android.dictation.HapticPatterns.Capabilities
import app.murmur.android.dictation.Haptics
import app.murmur.android.settings.SettingsStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowVibrator

/**
 * The dictation's haptics: one pattern per moment, chosen for what the vibrator can do; the
 * debounce that keeps a retry or a tap-tap from buzzing twice; the Haptics setting that switches
 * them all off; and the device sink, which asks the vibrator for touch feedback so the system's
 * own Touch feedback switch applies.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class HapticsTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val felt = mutableListOf<Haptic>()
    private var now = 0L

    private val vibrator: Vibrator
        get() = (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator

    @Before
    fun setUp() {
        context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        SettingsStore.get(context).update { it.copy(haptics = true) }
        Haptics.reset()
        Haptics.clock = { now }
        Haptics.sink = Haptics.Sink { felt += it }
    }

    @After
    fun tearDown() {
        Haptics.sink = null
        Haptics.clock = { SystemClock.uptimeMillis() }
        Haptics.reset()
    }

    /** The pattern for [haptic] on a vibrator with [caps], readable. */
    private fun pattern(haptic: Haptic, caps: Capabilities): String = describe(HapticPatterns.effect(haptic, caps))

    /**
     * A [VibrationEffect] segment by segment, through the framework's own getters: the predefined
     * effect's name, each primitive with its scale and delay, each step of a waveform. The segment
     * classes are hidden API, so by reflection.
     */
    private fun describe(effect: Any): String =
        describe(effect.javaClass.getMethod("getSegments").invoke(effect) as List<*>)

    private fun describe(segments: List<*>): String = segments.joinToString { segment ->
        val s = segment!!
        fun get(name: String): Any? = s.javaClass.getMethod(name).invoke(s)
        when (s.javaClass.simpleName) {
            "PrebakedSegment" -> effectName(get("getEffectId") as Int)
            "PrimitiveSegment" -> "${primitiveName(get("getPrimitiveId") as Int)}@${get("getScale")}+${get("getDelay")}ms"
            "StepSegment" -> "${if (get("getAmplitude") as Float == 0f) "off" else "on"} ${get("getDuration")}"
            else -> s.toString()
        }
    }

    /** What the device's vibrator was last asked for, read back off Robolectric's shadow (which keeps the segments, not the effect). */
    private fun lastVibration(): String {
        val field = ShadowVibrator::class.java.getDeclaredField("vibrationEffectSegments").apply { isAccessible = true }
        return describe(field.get(null) as List<*>)
    }

    private fun primitiveName(id: Int): String = when (id) {
        PRIMITIVE_TICK -> "tick"
        PRIMITIVE_CLICK -> "click"
        else -> "primitive $id"
    }

    private fun effectName(id: Int): String = when (id) {
        VibrationEffect.EFFECT_CLICK -> "click"
        VibrationEffect.EFFECT_TICK -> "tick"
        VibrationEffect.EFFECT_HEAVY_CLICK -> "heavy click"
        VibrationEffect.EFFECT_DOUBLE_CLICK -> "double click"
        else -> "effect $id"
    }

    /** The four moments every dictation has; LOCK and CANCEL are rarer and may share a feel with one of them. */
    private val key = listOf(Haptic.START, Haptic.STOP, Haptic.DONE, Haptic.ERROR)

    @Test
    fun `on a vibrator with primitives every moment is the platform's effect for it, and the four key moments differ`() {
        val caps = Capabilities(sdk = 35, primitives = true)
        assertEquals("click", pattern(Haptic.START, caps))
        assertEquals("tick", pattern(Haptic.STOP, caps))
        assertEquals("tick", pattern(Haptic.CANCEL, caps))
        assertEquals("tick@1.0+0ms, tick@1.0+40ms", pattern(Haptic.LOCK, caps))
        assertEquals("tick@0.6+0ms, click@1.0+50ms", pattern(Haptic.DONE, caps))
        assertEquals("double click", pattern(Haptic.ERROR, caps))
        val patterns = key.map { pattern(it, caps) }
        assertEquals("press, transcribing, done and error feel different: $patterns", 4, patterns.toSet().size)
    }

    @Test
    fun `without primitives the two-step patterns fall back to a predefined effect or a plain waveform`() {
        val caps = Capabilities(sdk = 35, primitives = false)
        assertEquals("click", pattern(Haptic.START, caps))
        assertEquals("tick", pattern(Haptic.STOP, caps))
        assertEquals("off 0, on 12, off 40, on 12", pattern(Haptic.LOCK, caps))
        assertEquals("heavy click", pattern(Haptic.DONE, caps))
        assertEquals("double click", pattern(Haptic.ERROR, caps))
        assertEquals(4, key.map { pattern(it, caps) }.toSet().size)
    }

    @Test
    fun `before Android 10 every moment is a plain pulse of its own weight`() {
        val caps = Capabilities(sdk = 28, primitives = false)
        assertEquals("on 20", pattern(Haptic.START, caps))
        assertEquals("on 10", pattern(Haptic.STOP, caps))
        assertEquals("on 10", pattern(Haptic.CANCEL, caps))
        assertEquals("off 0, on 12, off 40, on 12", pattern(Haptic.LOCK, caps))
        assertEquals("on 35", pattern(Haptic.DONE, caps))
        assertEquals("off 0, on 30, off 80, on 30", pattern(Haptic.ERROR, caps))
        assertEquals(4, key.map { pattern(it, caps) }.toSet().size)
    }

    @Test
    fun `the capabilities are read off the vibrator`() {
        shadowOf(vibrator).setSupportedPrimitives(listOf(PRIMITIVE_TICK, PRIMITIVE_CLICK))
        assertEquals(Capabilities(sdk = 35, primitives = true), Capabilities.of(vibrator))
        shadowOf(vibrator).setSupportedPrimitives(listOf(PRIMITIVE_CLICK))
        assertEquals(Capabilities(sdk = 35, primitives = false), Capabilities.of(vibrator))
    }

    @Test
    fun `a release on the heels of the last pattern is dropped, an outcome never is`() {
        val d = Haptics.Debounce(repeatMs = 1_500, gapMs = 100)
        assertTrue(d.accept(Haptic.START, 0))
        assertFalse("a stop 50 ms after the press is a tap-tap", d.accept(Haptic.STOP, 50))
        assertFalse(d.accept(Haptic.CANCEL, 99))
        assertTrue("the error that follows is felt", d.accept(Haptic.ERROR, 60))
        assertTrue(d.accept(Haptic.START, 2_000))
        assertTrue("done is never gated by the gap", d.accept(Haptic.DONE, 2_010))
        assertTrue(d.accept(Haptic.START, 4_000))
        assertTrue("a stop after the gap is a moment of its own", d.accept(Haptic.STOP, 4_100))
    }

    @Test
    fun `the same pattern again within a second and a half is not felt again`() {
        val d = Haptics.Debounce(repeatMs = 1_500, gapMs = 100)
        assertTrue(d.accept(Haptic.ERROR, 0))
        assertFalse("Retry hammered at a service that is down", d.accept(Haptic.ERROR, 400))
        assertFalse(d.accept(Haptic.ERROR, 1_499))
        assertTrue(d.accept(Haptic.ERROR, 1_500))
        assertTrue("a different pattern in between resets the count", d.accept(Haptic.START, 1_600))
        assertTrue(d.accept(Haptic.ERROR, 1_700))
        assertTrue(d.accept(Haptic.LOCK, 3_000))
        assertFalse("the lock chord pressed twice", d.accept(Haptic.LOCK, 3_400))
    }

    @Test
    fun `a dropped pattern leaves no trace, and a reset forgets the last one felt`() {
        val d = Haptics.Debounce(repeatMs = 1_500, gapMs = 100)
        assertTrue(d.accept(Haptic.START, 0))
        assertFalse(d.accept(Haptic.STOP, 50))
        // Judged against the press at 0, not the dropped stop at 50.
        assertTrue(d.accept(Haptic.STOP, 120))
        assertFalse(d.accept(Haptic.STOP, 500))
        d.reset()
        assertTrue(d.accept(Haptic.STOP, 510))
    }

    @Test
    fun `the Haptics setting switches every pattern off, and on again`() {
        SettingsStore.get(context).update { it.copy(haptics = false) }
        for (haptic in Haptic.entries) {
            now += 5_000
            Haptics.play(context, haptic)
        }
        assertEquals(emptyList<Haptic>(), felt)

        SettingsStore.get(context).update { it.copy(haptics = true) }
        for (haptic in Haptic.entries) {
            now += 5_000
            Haptics.play(context, haptic)
        }
        assertEquals(Haptic.entries.toList(), felt)
    }

    @Test
    fun `the debounce sits in front of the sink`() {
        Haptics.play(context, Haptic.START)
        now += 40
        Haptics.play(context, Haptic.STOP)
        now += 40
        Haptics.play(context, Haptic.ERROR)
        now += 200
        Haptics.play(context, Haptic.ERROR)
        assertEquals(listOf(Haptic.START, Haptic.ERROR), felt)
    }

    @Test
    fun `the device sink asks the vibrator for touch feedback, and stays still without a vibrator`() {
        Haptics.sink = null
        ShadowVibrator.reset()
        shadowOf(vibrator).setSupportedPrimitives(listOf(PRIMITIVE_TICK, PRIMITIVE_CLICK))

        Haptics.play(context, Haptic.START)
        val shadow = shadowOf(vibrator)
        assertTrue(shadow.isVibrating)
        assertEquals("click", lastVibration())
        val attributes = shadow.vibrationAttributesFromLastVibration as VibrationAttributes
        assertEquals("touch feedback, so the system's Touch feedback switch applies", VibrationAttributes.USAGE_TOUCH, attributes.usage)

        // The vibrator said it has the primitives, so done is the composed pair.
        now += 5_000
        Haptics.play(context, Haptic.DONE)
        assertEquals("tick@0.6+0ms, click@1.0+50ms", lastVibration())

        // A tablet without a vibrator: nothing is asked for, nothing is thrown.
        ShadowVibrator.reset()
        shadow.setHasVibrator(false)
        now += 5_000
        Haptics.play(context, Haptic.ERROR)
        assertFalse(shadow.isVibrating)
        assertEquals("", lastVibration())
    }
}
