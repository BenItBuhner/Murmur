package app.murmur.android.dictation

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import app.murmur.android.settings.SettingsStore
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.roundToInt
import kotlin.math.sin

private const val TAG = "MurmurCues"

/** The moments a dictation makes itself heard (and felt); the desktop's `SoundName`. */
enum class Cue { START, STOP, LOCK, CANCEL, ERROR }

/**
 * Short synthesized cues for the moments of a dictation, the desktop overlay's `sounds.ts` note for
 * note: the same frequencies, offsets, lengths and envelope (an 8 ms attack, an exponential decay to
 * silence), so a dictation sounds the same on a phone beside a laptop. Rendered to PCM on demand
 * and played through a short-lived [AudioTrack] on the system-sounds stream; no asset files. A
 * light tap from the vibrator goes with each cue when haptics are on.
 */
object Cues {
    const val SAMPLE_RATE = 44_100

    private enum class Wave { SINE, TRIANGLE }

    /** One note: [freq] Hz from [start] s, fading out over [duration] s, peaking at [gain] of full scale. */
    private data class Note(val freq: Double, val start: Double, val duration: Double, val gain: Double, val wave: Wave = Wave.SINE)

    private fun notes(cue: Cue, v: Double): List<Note> = when (cue) {
        Cue.START -> listOf(Note(660.0, 0.0, 0.09, v), Note(990.0, 0.07, 0.11, v))
        Cue.STOP -> listOf(Note(880.0, 0.0, 0.08, v), Note(587.0, 0.07, 0.12, v))
        Cue.LOCK -> listOf(Note(660.0, 0.0, 0.07, v), Note(880.0, 0.06, 0.07, v), Note(1174.0, 0.12, 0.12, v))
        Cue.CANCEL -> listOf(Note(440.0, 0.0, 0.06, v * 0.8), Note(330.0, 0.05, 0.1, v * 0.8))
        Cue.ERROR -> listOf(Note(220.0, 0.0, 0.16, v * 0.9, Wave.TRIANGLE), Note(196.0, 0.12, 0.2, v * 0.9, Wave.TRIANGLE))
    }

    /**
     * The cue as 16-bit mono PCM at [SAMPLE_RATE], or null when [volume] is zero. The desktop plays
     * each note at half the volume setting; the same here.
     */
    fun pcm(cue: Cue, volume: Float): ShortArray? {
        val vol = volume.coerceIn(0f, 1f).toDouble()
        if (vol <= 0.0) return null
        val notes = notes(cue, vol * 0.5)
        val end = notes.maxOf { it.start + it.duration } + 0.02
        val samples = (end * SAMPLE_RATE).roundToInt()
        val mix = DoubleArray(samples)
        for (n in notes) {
            val from = (n.start * SAMPLE_RATE).roundToInt()
            val to = ((n.start + n.duration) * SAMPLE_RATE).roundToInt().coerceAtMost(samples)
            val attack = 0.008 * SAMPLE_RATE
            // Exponential ramp from the peak down to 0.0001 by the end of the note, as the desktop's gain node.
            val decayLength = (to - from) - attack
            val decayRate = ln(0.0001 / n.gain) / decayLength
            for (i in from until to) {
                val t = (i - from).toDouble()
                val env = if (t < attack) n.gain * (t / attack) else n.gain * exp(decayRate * (t - attack))
                val phase = 2.0 * PI * n.freq * (i.toDouble() / SAMPLE_RATE)
                val wave = when (n.wave) {
                    Wave.SINE -> sin(phase)
                    Wave.TRIANGLE -> 2.0 / PI * kotlin.math.asin(sin(phase))
                }
                mix[i] += env * wave
            }
        }
        return ShortArray(samples) { i -> (mix[i].coerceIn(-1.0, 1.0) * Short.MAX_VALUE).roundToInt().toShort() }
    }

    /** Play [cue] and tap the vibrator, as the settings allow. Never throws; a device without a speaker just stays quiet. */
    fun play(context: Context, cue: Cue) {
        val app = context.applicationContext
        val s = SettingsStore.get(app).get()
        if (s.sounds) {
            pcm(cue, s.soundVolume)?.let { samples ->
                runCatching { playPcm(samples) }.onFailure { Log.w(TAG, "could not play the $cue cue", it) }
            }
        }
        if (s.haptics) runCatching { tap(app, cue) }.onFailure { Log.w(TAG, "could not vibrate for $cue", it) }
    }

    private fun playPcm(samples: ShortArray) {
        val bytes = samples.size * 2
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(bytes)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        track.write(samples, 0, samples.size)
        track.setNotificationMarkerPosition(samples.size)
        track.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
            override fun onMarkerReached(t: AudioTrack) {
                t.release()
            }

            override fun onPeriodicNotification(t: AudioTrack) = Unit
        })
        track.play()
    }

    /** A click for the moments a dictation begins or ends, a heavier one for a failure. */
    private fun tap(app: Context, cue: Cue) {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (app.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            app.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        } ?: return
        if (!vibrator.hasVibrator()) return
        val effect = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            VibrationEffect.createPredefined(
                when (cue) {
                    Cue.ERROR -> VibrationEffect.EFFECT_HEAVY_CLICK
                    Cue.CANCEL -> VibrationEffect.EFFECT_TICK
                    else -> VibrationEffect.EFFECT_CLICK
                }
            )
        } else {
            VibrationEffect.createOneShot(if (cue == Cue.ERROR) 40L else 15L, VibrationEffect.DEFAULT_AMPLITUDE)
        }
        vibrator.vibrate(effect)
    }

    /** For tests: the loudest sample of [samples], as a fraction of full scale. */
    fun peak(samples: ShortArray): Double = samples.maxOfOrNull { abs(it.toInt()) }?.toDouble()?.div(Short.MAX_VALUE) ?: 0.0
}
