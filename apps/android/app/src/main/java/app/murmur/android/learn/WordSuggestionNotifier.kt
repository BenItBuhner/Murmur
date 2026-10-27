package app.murmur.android.learn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import app.murmur.android.MainActivity
import app.murmur.android.R
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.WordSuggestion
import app.murmur.android.settings.WordSuggestions
import app.murmur.android.ui.Route

/**
 * Tells the user Murmur noticed a correction: "Add “Wispr Flow” to your dictionary?" with Add and
 * "Not a word". Quiet (no sound, no heads-up) on a channel of its own the user can turn off. The
 * same suggestions wait on the Dictionary screen.
 */
object WordSuggestionNotifier {
    const val CHANNEL_ID = "murmur_word_suggestions"
    private const val NOTIFICATION_ID = 1407
    const val ACTION_ADD = "app.murmur.android.WORD_ADD"
    const val ACTION_DECLINE = "app.murmur.android.WORD_DECLINE"
    const val EXTRA_WORD = "word"

    fun headline(s: WordSuggestion): String =
        if (s.kind == "alias") "Remember “${s.heard}” means “${s.word}”?" else "Add “${s.word}” to your dictionary?"

    fun show(context: Context, suggestion: WordSuggestion) {
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, context.getString(R.string.notification_channel_words), NotificationManager.IMPORTANCE_LOW).apply {
                        description = context.getString(R.string.notification_channel_words_description)
                        setShowBadge(false)
                    }
                )
            }
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION") Notification.Builder(context).setPriority(Notification.PRIORITY_LOW)
            }
            val body = if (suggestion.kind == "alias") {
                "Next time the speech model hears “${suggestion.heard}”, Murmur types “${suggestion.word}”."
            } else {
                "You changed “${suggestion.heard}” to “${suggestion.word}”. Add it and Murmur spells it your way from now on."
            }
            val tap = PendingIntent.getActivity(
                context, 0, MainActivity.intentFor(context, Route.DICTIONARY),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val n = builder
                .setSmallIcon(R.drawable.ic_mic_notification)
                .setContentTitle(headline(suggestion))
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setContentIntent(tap)
                .setAutoCancel(true)
                .addAction(Notification.Action.Builder(null, "Add", action(context, ACTION_ADD, suggestion.word, 1)).build())
                .addAction(Notification.Action.Builder(null, "Not a word", action(context, ACTION_DECLINE, suggestion.word, 2)).build())
                .build()
            nm.notify(NOTIFICATION_ID, n)
        } catch (e: Exception) {
            // Without the notification permission the suggestion still waits on the Dictionary screen.
            Log.w("Murmur", "word suggestion notification failed: ${e.message}")
        }
    }

    fun cancel(context: Context) {
        runCatching { (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFICATION_ID) }
    }

    private fun action(context: Context, action: String, word: String, code: Int): PendingIntent =
        PendingIntent.getBroadcast(
            context, code,
            Intent(context, WordSuggestionReceiver::class.java).setAction(action).putExtra(EXTRA_WORD, word),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
}

/** The notification's Add and "Not a word" buttons. */
class WordSuggestionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val word = intent.getStringExtra(WordSuggestionNotifier.EXTRA_WORD) ?: return
        val suggestions = WordSuggestions.get(context)
        when (intent.action) {
            WordSuggestionNotifier.ACTION_ADD -> suggestions.accept(word, SettingsStore.get(context))
            WordSuggestionNotifier.ACTION_DECLINE -> suggestions.decline(word)
            else -> return
        }
        WordSuggestionNotifier.cancel(context)
    }
}
