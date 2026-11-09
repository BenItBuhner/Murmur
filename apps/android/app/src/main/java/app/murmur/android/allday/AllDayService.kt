package app.murmur.android.allday

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.util.Log
import app.murmur.android.R
import app.murmur.android.audio.Wav
import app.murmur.android.MurmurApplication
import app.murmur.android.cloud.ClerkTokens
import java.net.URLEncoder
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

private const val TAG = "MurmurAllDay"
private const val CHANNEL = "allday"
private const val NOTIFICATION_ID = 7301
private const val RATE = 16_000
/** About an hour of speech held while offline (~800 KB a piece). */
private const val MAX_PENDING = 150

/**
 * All-day recording: off unless the person turns it on (Phone microphone screen). Holds the
 * microphone in a foreground service, cuts it into ~25 s pieces and sends the ones with sound to the
 * server (/v1/timeline/audio), which transcribes, scores and keeps them for Ephemeris on the desktop,
 * from any network. The phone only records: no transcription or analysis runs here, and audio is not
 * kept once sent.
 */
class AllDayService : Service() {
    private var scope: CoroutineScope? = null
    @Volatile private var running = false
    private var thread: Thread? = null
    private val pieces = Channel<Piece>(capacity = 32)
    private class Upload(val url: String, val wav: ByteArray)
    private val pending = ArrayList<Upload>()
    private val http = OkHttpClient.Builder().callTimeout(90, TimeUnit.SECONDS).build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!AllDay.enabled(this)) { stopSelf(); return START_NOT_STICKY }
        if (!foreground()) { stopSelf(); return START_NOT_STICKY }
        if (running) return START_STICKY
        running = true
        val s = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope = s
        s.launch { for (p in pieces) runCatching { handle(p) }.onFailure { Log.w(TAG, "piece dropped", it) } }
        thread = Thread(::capture, "allday-mic").apply { start() }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        thread?.join(1500)
        pieces.close()
        scope?.cancel()
        super.onDestroy()
    }

    @SuppressLint("MissingPermission")
    private fun capture() {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, maxOf(min, RATE))
        } catch (e: Exception) { Log.e(TAG, "microphone unavailable", e); stopSelf(); return }
        val cutter = AllDayPieces(RATE)
        val buf = ShortArray(RATE / 10)
        try {
            rec.startRecording()
            while (running) {
                val n = rec.read(buf, 0, buf.size)
                if (n <= 0) continue
                for (p in cutter.push(buf, n)) pieces.trySend(p)
            }
            cutter.flush()?.let { pieces.trySend(it) }
        } catch (e: Exception) {
            Log.e(TAG, "capture stopped", e)
        } finally {
            runCatching { rec.stop() }
            rec.release()
        }
    }

    /** Sends a piece of speech to the server, which transcribes, scores and keeps it. */
    private fun handle(p: Piece) {
        if (p.silent) return
        val site = (application as? MurmurApplication)?.cloudConfig?.convexSiteUrl.orEmpty()
        if (site.isEmpty()) return
        synchronized(pending) {
            pending += Upload(AllDay.uploadUrl(site, AllDay.deviceName(), p), Wav.encodePcm16(p.pcm, RATE))
            while (pending.size > MAX_PENDING) pending.removeAt(0)
        }
        flush()
    }

    /** Uploads waiting pieces in order; stops at the first failure and tries again with the next piece. */
    private fun flush() {
        while (true) {
            val next = synchronized(pending) { pending.firstOrNull() } ?: return
            val token = runBlocking { runCatching { ClerkTokens.sessionToken(false) }.getOrNull() } ?: return
            val ok = runCatching {
                http.newCall(
                    Request.Builder().url(next.url)
                        .header("Authorization", "Bearer $token")
                        .post(next.wav.toRequestBody("audio/wav".toMediaType()))
                        .build()
                ).execute().use { it.isSuccessful || it.code in 400..403 }
            }.getOrElse { Log.w(TAG, "upload failed: ${it.message}"); false }
            if (!ok) return
            synchronized(pending) { pending.remove(next) }
        }
    }

    private fun foreground(): Boolean {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, getString(R.string.allday_channel), NotificationManager.IMPORTANCE_MIN)
            )
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)
            ?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE) }
        @Suppress("DEPRECATION")
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        val n = b.setSmallIcon(R.drawable.ic_mic_notification)
            .setContentTitle(getString(R.string.allday_notification_title))
            .setContentText(getString(R.string.allday_notification_text))
            .apply { if (launch != null) setContentIntent(launch) }
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .build()
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else startForeground(NOTIFICATION_ID, n)
            true
        } catch (e: Exception) {
            Log.e(TAG, "could not start in the foreground", e)
            false
        }
    }
}

/** The switch, and the shape of what is relayed. */
object AllDay {
    private const val PREFS = "allday"
    private const val KEY = "enabled"

    fun enabled(c: Context): Boolean = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, false)

    fun setEnabled(c: Context, on: Boolean) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, on).apply()
        val i = Intent(c, AllDayService::class.java)
        if (on) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i) else c.startService(i)
        } else c.stopService(i)
    }

    fun deviceName(): String = "phone:${Build.MANUFACTURER} ${Build.MODEL}".take(120)

    /** Where a piece goes: the server's all-day endpoint, with what the piece is. */
    fun uploadUrl(site: String, device: String, p: Piece): String {
        fun q(v: String) = URLEncoder.encode(v, "UTF-8")
        return site.trim().trimEnd('/') + "/v1/timeline/audio?device=" + q(device) +
            "&startedAt=" + q(Instant.ofEpochMilli(p.startedAtMs).toString()) +
            "&endedAt=" + q(Instant.ofEpochMilli(p.endedAtMs).toString())
    }
}
