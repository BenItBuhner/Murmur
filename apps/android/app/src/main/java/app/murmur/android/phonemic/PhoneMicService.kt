package app.murmur.android.phonemic

import android.app.Notification
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
import app.murmur.android.MainActivity
import app.murmur.android.R
import app.murmur.android.ui.Route
import app.murmur.android.service.RecordingService

/**
 * Holds the foreground (type `microphone`) and a partial wake lock while the phone is a desktop's
 * microphone, so the link and the capture survive the screen turning off for a long dictation.
 * Started when a link begins and stopped when it ends; it shares the recording notification's
 * quiet channel.
 */
class PhoneMicService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) RecordingService.ensureChannel(this, nm)
        val desktop = intent?.getStringExtra(EXTRA_DESKTOP) ?: "your computer"
        val contentIntent = PendingIntent.getActivity(
            this, 1, MainActivity.intentFor(this, Route.PHONE_MIC),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification: Notification =
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, RecordingService.CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION") Notification.Builder(this).setPriority(Notification.PRIORITY_MIN)
            })
                .setSmallIcon(R.drawable.ic_mic_notification)
                .setContentTitle(getString(R.string.app_name))
                .setContentText("Microphone for $desktop")
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setLocalOnly(true)
                .build()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            // Without the foreground the link still works while the screen is on.
            Log.e("MurmurPhoneMic", "startForeground failed", e)
            stopSelf(startId)
        }
        synchronized(Companion) {
            starting = false
            if (stopRequested) {
                // The link ended before the service got here: Android requires startForeground
                // above, and then it can go.
                stopRequested = false
                stopSelf()
                return START_NOT_STICKY
            }
        }
        if (wakeLock == null) wakeLock = RecordingService.acquireWakeLock(this, "murmur:phone-mic", WAKE_LOCK_MS)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    companion object {
        private const val NOTIFICATION_ID = 1292
        /** Longest a link keeps the CPU awake; a backstop if the service is never stopped. */
        private const val WAKE_LOCK_MS = 4 * 60 * 60_000L
        const val EXTRA_DESKTOP = "desktop"

        /** Started and not yet in the foreground: stopping it now would crash the app. */
        private var starting = false
        private var stopRequested = false

        fun start(context: Context, desktop: String) {
            val intent = Intent(context, PhoneMicService::class.java).putExtra(EXTRA_DESKTOP, desktop)
            synchronized(Companion) {
                stopRequested = false
                starting = runCatching {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
                    else context.startService(intent)
                }.onFailure { Log.w("MurmurPhoneMic", "could not start the foreground service", it) }.isSuccess
            }
        }

        fun stop(context: Context) {
            synchronized(Companion) {
                if (starting) {
                    stopRequested = true
                    return
                }
            }
            runCatching { context.stopService(Intent(context, PhoneMicService::class.java)) }
        }
    }
}
