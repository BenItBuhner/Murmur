package app.murmur.android.dictation

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.SystemClock
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.VibrationEffect.Composition.PRIMITIVE_CLICK
import android.os.VibrationEffect.Composition.PRIMITIVE_TICK
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import app.murmur.android.settings.SettingsStore

private const val TAG = "MurmurHaptics"

/**
 * The moments of a dictation the phone marks with a touch, whatever started it: the floating
 * button, the desktop-style pill, a hardware shortcut, a Retry. Each has its own pattern
 * ([HapticPatterns]), so a dictation can be followed by hand without looking at the pill.
 *
 * [release] marks the two that end the listening under the user's finger. Those are the ones the
 * debounce swallows when they land on the heels of the press (a tap-tap on the button, a command
 * session cancelled on the spot): what follows, an error, says it all.
 */
enum class Haptic(val release: Boolean = false) {
    /** Recording began: a firm click, the platform's gesture start. */
    START,

    /** Recording ended and the speech is on its way to the speech model: a light tick, the platform's gesture end. */
    STOP(release = true),

    /** A held shortcut was tapped, or the hands-free chord pressed: hands-free until stopped. Two quick ticks, a latch. */
    LOCK,

    /** The session was thrown away: the same light tick as a stop. */
    CANCEL(release = true),

    /** The text is in the field (or on the clipboard): a light tick then a firm click, the success pair. */
    DONE,

    /**
     * Something needs the user's eyes: a plan limit, a Murmur service that is down, nothing heard,
     * too short. The platform's reject, a double click.
     */
    ERROR
}

/**
 * Haptic feedback for a dictation, one pattern per [Haptic], distinct enough that press,
 * transcribing, done and error feel different. Everything goes through [play], which reads the
 * Haptics setting, drops what would make the phone buzz twice for one thing, and hands the pattern
 * to the [Sink]: the device's vibrator, or whatever a test installs.
 *
 * The vibrator is asked for touch feedback (`VibrationAttributes.USAGE_TOUCH`; on older releases
 * the sonification audio usage the system maps onto it), so the system's Touch feedback switch and
 * intensity apply to these as they do to the keyboard's own taps. The desktop has no vibrator, so
 * this setting is the phone's alone (`androidOnly` in the settings parity contract).
 */
object Haptics {
    /** Where a pattern goes once the setting and the debounce let it through. */
    fun interface Sink {
        fun play(haptic: Haptic)
    }

    /**
     * The same pattern again within this long of the last one felt is not felt again: Retry
     * hammered against a service that is down, the lock chord pressed twice.
     */
    const val REPEAT_MS = 1_500L

    /**
     * A [Haptic.release] this soon after the last pattern is the end of a tap-tap or of an automatic
     * cancel, not a moment of its own; the error that follows is what the hand should feel.
     */
    const val GAP_MS = 100L

    /** Tests install a recorder here; null means the device's vibrator. */
    @Volatile var sink: Sink? = null

    /** Monotonic milliseconds for the debounce; tests hand in a clock of their own. */
    @Volatile var clock: () -> Long = { SystemClock.uptimeMillis() }

    private val debounce = Debounce(REPEAT_MS, GAP_MS)

    @Volatile private var device: DeviceSink? = null

    /** Feel [haptic], as the settings and the debounce allow. Never throws; a phone without a vibrator stays still. */
    fun play(context: Context, haptic: Haptic) {
        val app = context.applicationContext
        if (!SettingsStore.get(app).get().haptics) return
        if (!debounce.accept(haptic, clock())) return
        val target = sink ?: device ?: DeviceSink(app).also { device = it }
        runCatching { target.play(haptic) }.onFailure { Log.w(TAG, "could not vibrate for $haptic", it) }
    }

    /** Tests: forget what was last felt, so one test's final pattern does not debounce the next test's first. */
    fun reset() = debounce.reset()

    /**
     * The rules that keep a dictation from buzzing twice for one thing. A pattern is accepted
     * unless it repeats the last one felt within [repeatMs], or it is a release within [gapMs] of
     * the last one felt. A pattern that was dropped leaves no trace: the next one is judged against
     * the last that was actually felt.
     */
    class Debounce(private val repeatMs: Long, private val gapMs: Long) {
        private var last: Haptic? = null
        private var lastAt = 0L

        @Synchronized
        fun accept(haptic: Haptic, now: Long): Boolean {
            val previous = last
            if (previous != null) {
                val since = now - lastAt
                if (haptic == previous && since < repeatMs) return false
                if (haptic.release && since < gapMs) return false
            }
            last = haptic
            lastAt = now
            return true
        }

        @Synchronized
        fun reset() {
            last = null
            lastAt = 0L
        }
    }
}

/**
 * The vibration behind each [Haptic], chosen for what the vibrator can do. The platform's own
 * effects wherever one fits: the predefined click, tick, heavy click and double click are what
 * `View.performHapticFeedback` plays for GESTURE_START, GESTURE_END, LONG_PRESS and REJECT, tuned
 * by each device maker; the two-step patterns are composed from primitives on a vibrator that
 * supports them and fall back to a predefined effect or a plain waveform. Phones older than
 * Android 10 (no predefined effects) get plain pulses of matching weight.
 *
 * | Moment | Primitives (Android 11+, supported) | Predefined (Android 10+) | Older       |
 * |--------|-------------------------------------|--------------------------|-------------|
 * | START  | click                               | click                    | 20 ms       |
 * | STOP   | tick                                | tick                     | 10 ms       |
 * | LOCK   | tick, tick 40 ms later              | 12 ms, 40 ms, 12 ms      | the same    |
 * | CANCEL | tick                                | tick                     | 10 ms       |
 * | DONE   | tick at 0.6, click 50 ms later      | heavy click              | 35 ms       |
 * | ERROR  | double click                        | double click             | 30, 80, 30  |
 */
object HapticPatterns {
    /** What the vibrator can do: its SDK, and whether it has the primitives the two-step patterns are composed from. */
    data class Capabilities(val sdk: Int, val primitives: Boolean) {
        companion object {
            fun of(vibrator: Vibrator): Capabilities = Capabilities(
                sdk = Build.VERSION.SDK_INT,
                primitives = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
                    vibrator.areAllPrimitivesSupported(PRIMITIVE_TICK, PRIMITIVE_CLICK)
            )
        }
    }

    /**
     * The effect for [haptic] on a vibrator with [caps]. A pure function of the capabilities, so
     * every tier can be checked on one test SDK; the tiers follow `caps.sdk`, which lint cannot
     * see is the running SDK (or a test's), hence the suppression.
     */
    @SuppressLint("NewApi")
    fun effect(haptic: Haptic, caps: Capabilities): VibrationEffect {
        val predefined = caps.sdk >= Build.VERSION_CODES.Q
        return when (haptic) {
            Haptic.START -> if (predefined) VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK) else pulse(20)
            Haptic.STOP, Haptic.CANCEL -> if (predefined) VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK) else pulse(10)
            Haptic.LOCK -> if (caps.primitives) {
                VibrationEffect.startComposition()
                    .addPrimitive(PRIMITIVE_TICK, 1f)
                    .addPrimitive(PRIMITIVE_TICK, 1f, 40)
                    .compose()
            } else {
                VibrationEffect.createWaveform(longArrayOf(0, 12, 40, 12), -1)
            }
            Haptic.DONE -> when {
                caps.primitives -> VibrationEffect.startComposition()
                    .addPrimitive(PRIMITIVE_TICK, 0.6f)
                    .addPrimitive(PRIMITIVE_CLICK, 1f, 50)
                    .compose()
                predefined -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK)
                else -> pulse(35)
            }
            Haptic.ERROR -> if (predefined) {
                VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK)
            } else {
                VibrationEffect.createWaveform(longArrayOf(0, 30, 80, 30), -1)
            }
        }
    }

    private fun pulse(ms: Long): VibrationEffect = VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)
}

/** The device's vibrator, asked for each pattern as touch feedback. */
internal class DeviceSink(context: Context) : Haptics.Sink {
    private val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

    override fun play(haptic: Haptic) {
        val vibrator = vibrator ?: return
        if (!vibrator.hasVibrator()) return
        val effect = HapticPatterns.effect(haptic, HapticPatterns.Capabilities.of(vibrator))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            vibrator.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH))
        } else {
            // What the system maps onto USAGE_TOUCH on Android 12, and treats as haptic feedback before it.
            @Suppress("DEPRECATION")
            vibrator.vibrate(
                effect,
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
        }
    }
}
