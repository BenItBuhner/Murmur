package app.murmur.android.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import app.murmur.android.R

private const val TAG = "MurmurRecordingSvc"

/**
 * Foreground service with the `microphone` type: modern Android only allows mic capture
 * from the background while a service like this is running. Started right before recording
 * begins (the overlay pill tap) and stopped as soon as the recording ends.
 *
 * The notice cannot be omitted. A microphone foreground service has to call [startForeground]
 * with a notification, and a channel below [NotificationManager.IMPORTANCE_LOW] is discarded
 * and replaced by the system's own "running in the background" notice. Dropping the service
 * would drop the mic while Murmur is dictating into another app. Android 12+ then withholds
 * that notice for about ten seconds — longer when the process has been in the background,
 * which is the gap before it appears mid-dictation — and posts it as a new alert. The pill
 * already shows recording state, so the notice stays at the lowest importance Android will
 * keep: ongoing, silent, and not a heads-up.
 */
class RecordingService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val notification = recordingNotification(nm)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            // Android 14+ throws (SecurityException / ForegroundServiceStartNotAllowedException) when
            // the mic permission was revoked or the start is not allowed from the background. An
            // uncaught exception here would kill the whole process, accessibility service included;
            // the recorder reports the problem on the pill instead.
            Log.e(TAG, "startForeground failed; recording continues without the foreground service", e)
            stopSelf(startId)
        }
        // The CPU stays up for the whole session (a long dictation with the screen off keeps sending
        // pieces); the timeout is a backstop in case the service is never stopped.
        if (wakeLock == null) wakeLock = acquireWakeLock(this, "murmur:recording", RECORDING_WAKE_LOCK_MS)
        return START_NOT_STICKY
    }

    /**
     * Lowest importance Android will actually display for a foreground service. Lower, and the
     * system substitutes a louder notice of its own. A channel's importance is frozen once
     * created, so the quiet one is a new id and the previous Dictation channel is removed.
     */
    private fun recordingNotification(nm: NotificationManager): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.deleteNotificationChannel(LEGACY_CHANNEL_ID)
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW
            )
            channel.setSound(null, null)
            channel.enableVibration(false)
            channel.enableLights(false)
            channel.setShowBadge(false)
            nm.createNotificationChannel(channel)
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = launch?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }
        // Channel importance is what current Android alerts on. Priority, defaults and
        // vibration are what older builds and some OEM skins still use to decide a heads-up,
        // and the defaults are high enough for that delayed post to pop over the screen.
        @Suppress("DEPRECATION")
        builder
            .setSmallIcon(R.drawable.ic_mic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.notification_recording))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setSound(null, null)
            .setDefaults(0)
            .setVibrate(null)
            .setPriority(Notification.PRIORITY_LOW)
        if (contentIntent != null) builder.setContentIntent(contentIntent)
        // Leave the platform's short-service deferral in place so a brief recording still
        // shows nothing. When the deferral ends, the notice above is not allowed to alert.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_DEFERRED)
        }
        return builder.build()
    }

    companion object {
        /** Longest a recording keeps the CPU awake: past the 30-minute session limit, with margin. */
        const val RECORDING_WAKE_LOCK_MS = 35 * 60_000L
        /** Longest a release keeps the CPU awake (the release deadline's maximum). */
        const val PROCESSING_WAKE_LOCK_MS = 4 * 60_000L

        /** A partial wake lock with a timeout, or null when the system refuses one. */
        fun acquireWakeLock(context: Context, tag: String, timeoutMs: Long): PowerManager.WakeLock? = try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, tag).apply {
                setReferenceCounted(false)
                acquire(timeoutMs)
            }
        } catch (e: Exception) {
            Log.w(TAG, "no wake lock: ${e.message}")
            null
        }

        private const val NOTIFICATION_ID = 1291
        private const val LEGACY_CHANNEL_ID = "murmur_dictation"
        const val CHANNEL_ID = "murmur_dictation_quiet"

        fun start(context: Context) {
            val intent = Intent(context, RecordingService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RecordingService::class.java))
        }
    }
}
