package app.murmur.android

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import app.murmur.android.service.RecordingService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The microphone foreground service has to keep a notification or Android drops the mic while
 * Murmur is dictating into another app. That notice is the one that appears mid-recording: it
 * must stay ongoing and silent, and it must not be posted on a channel that can heads-up.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RecordingServiceTest {

    @Test
    @Suppress("DEPRECATION") // priority, sound and vibrate are what OEM skins still alert on
    fun `the dictation notice is ongoing and silent, and a loud legacy channel is removed`() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val nm = app.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel("murmur_dictation", "Dictation", NotificationManager.IMPORTANCE_HIGH)
        )

        val service = Robolectric.buildService(RecordingService::class.java).create().startCommand(0, 0).get()
        val shadow = shadowOf(service)
        val posted = shadow.lastForegroundNotification

        assertFalse("startForeground failing must not stop the service out from under the mic", shadow.isStoppedBySelf)
        assertNull("the loud channel of earlier builds is gone", nm.getNotificationChannel("murmur_dictation"))

        val channel = nm.getNotificationChannel(RecordingService.CHANNEL_ID)
        assertEquals(
            "lowest importance Android will keep for a foreground service; lower and the system substitutes its own",
            NotificationManager.IMPORTANCE_LOW,
            channel.importance
        )
        assertTrue("low importance does not heads-up", channel.importance < NotificationManager.IMPORTANCE_HIGH)
        assertNull("no sound", channel.sound)
        assertFalse("no vibration", channel.shouldVibrate())
        assertFalse("no lights", channel.shouldShowLights())
        assertFalse("no launcher badge", channel.canShowBadge())

        assertEquals(Notification.FLAG_ONGOING_EVENT, posted.flags and Notification.FLAG_ONGOING_EVENT)
        assertEquals(Notification.FLAG_ONLY_ALERT_ONCE, posted.flags and Notification.FLAG_ONLY_ALERT_ONCE)
        assertEquals(Notification.PRIORITY_LOW, posted.priority)
        assertNull("no sound", posted.sound)
        assertNull("no vibration", posted.vibrate)
        assertEquals(0, posted.defaults and (Notification.DEFAULT_ALL))
        assertEquals(Notification.CATEGORY_SERVICE, posted.category)
        assertNull("no full-screen heads-up", posted.fullScreenIntent)
        // Hidden API: the deferral flag is not on the SDK stub, but it is what stops Android 12+
        // from posting this notice as an immediate alert.
        val forceDeferred = Notification::class.java.getMethod("isForegroundDisplayForceDeferred").invoke(posted) as Boolean
        val showImmediately = Notification::class.java.getMethod("shouldShowForegroundImmediately").invoke(posted) as Boolean
        assertTrue("a short recording stays hidden; the later post must not be an immediate alert", forceDeferred)
        assertFalse(showImmediately)
    }
}
