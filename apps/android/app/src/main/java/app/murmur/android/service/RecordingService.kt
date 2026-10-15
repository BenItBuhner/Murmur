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
        val channelId = "murmur_dictation"
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(
                    channelId,
                    getString(R.string.notification_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                )
            )
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = launch?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
        }
        val notification: Notification =
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, channelId)
            } else {
                @Suppress("DEPRECATION") Notification.Builder(this)
            })
                .setSmallIcon(R.drawable.ic_mic_notification)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.notification_recording))
                .apply { if (contentIntent != null) setContentIntent(contentIntent) }
                .setOngoing(true)
                .build()
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
