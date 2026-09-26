package app.murmur.android.service

import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
import app.murmur.android.BuildConfig

/**
 * How the keyboard's recent openings and closings reached the accessibility service and what came of
 * them, so a report from a phone can say where the time went: every accessibility event (and how long
 * it took to arrive), every window list read and what it said about the keyboard's window, what the
 * tracker made of it, the timers it set, the signs of the keyboard leaving, and when the button's
 * windows were added and its first frame drawn. Lines carry the uptime clock, the one accessibility
 * events and the main thread's timers run on.
 *
 * Always on, in memory only, and bounded: the last [SEGMENTS] stretches between the keyboard coming up
 * and going away, each keeping its first [HEAD_LINES] and last [TAIL_LINES] lines. Every line also goes
 * to logcat under [TAG]. Nothing leaves the phone unless the user copies it (Permissions, Diagnostics).
 */
object KeyboardTimingLog {
    const val TAG = "MurmurKb"
    private const val SEGMENTS = 8
    private const val HEAD_LINES = 60
    private const val TAIL_LINES = 100

    private class Segment(val title: String) {
        val head = ArrayList<String>(HEAD_LINES)
        val tail = ArrayDeque<String>(TAIL_LINES)
        var dropped = 0

        fun add(line: String) {
            if (head.size < HEAD_LINES) {
                head += line
                return
            }
            if (tail.size == TAIL_LINES) {
                tail.removeFirst()
                dropped++
            }
            tail.addLast(line)
        }
    }

    private val segments = ArrayDeque<Segment>()
    private var lastAt = -1L
    private var openings = 0

    /** One line: its time, the time since the line before it, and [message]. */
    @Synchronized
    fun record(nowMs: Long, message: String) {
        val line = "$nowMs +${if (lastAt < 0L) 0L else nowMs - lastAt} $message"
        lastAt = nowMs
        if (segments.isEmpty()) start("== earlier ==")
        segments.last().add(line)
        Log.i(TAG, line)
    }

    /** The keyboard came up ([up]) or went away: what follows is the next stretch. */
    @Synchronized
    fun keyboardChanged(nowMs: Long, up: Boolean) {
        if (up) openings++
        start("== keyboard ${if (up) "up" else "gone"} #$openings at $nowMs ==")
    }

    /** A stretch that starts with something other than the keyboard, such as the service connecting. */
    @Synchronized
    fun section(nowMs: Long, what: String) = start("== $what at $nowMs ==")

    private fun start(title: String) {
        segments.addLast(Segment(title))
        while (segments.size > SEGMENTS) segments.removeFirst()
        Log.i(TAG, title)
    }

    /** Every stretch kept, oldest first. */
    @Synchronized
    fun text(): String = buildString {
        for (segment in segments) {
            appendLine(segment.title)
            for (line in segment.head) appendLine(line)
            if (segment.dropped > 0) appendLine("... ${segment.dropped} lines dropped ...")
            for (line in segment.tail) appendLine(line)
        }
    }

    @Synchronized
    fun clear() {
        segments.clear()
        lastAt = -1L
        openings = 0
    }

    /** What "Copy keyboard timing log" puts on the clipboard: the phone, the keyboard, what was learnt, then [text]. */
    fun report(context: Context): String {
        val keyboard = runCatching {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
        }.getOrNull()
        val offsets = runCatching {
            context.getSharedPreferences(StoredKeyboardOffsets.PREFS, Context.MODE_PRIVATE).all
        }.getOrNull().orEmpty().entries.sortedBy { it.key }.joinToString(", ") { "${it.key}=${it.value}" }
        val (w, h) = screenSize(context)
        return buildString {
            appendLine("Murmur keyboard timing log")
            appendLine(
                "Murmur ${BuildConfig.VERSION_NAME} on ${Build.MANUFACTURER} ${Build.MODEL}, " +
                    "Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}), build ${Build.DISPLAY}"
            )
            appendLine("keyboard: ${keyboard ?: "unknown"}")
            appendLine(
                "screen ${w}x$h px at ${context.resources.displayMetrics.density}x; accessibility service " +
                    "${if (MurmurAccessibilityService.isRunning) "on" else "off"}; uptime now ${SystemClock.uptimeMillis()}"
            )
            appendLine("resting offsets remembered (dp): ${offsets.ifEmpty { "none" }}")
            appendLine(
                "Each line: uptime ms, +ms since the line before, what happened. ev: accessibility event " +
                    "(age: ms since it was raised; src: ms to read its view). win: window list read (ime#id " +
                    "L=layer a=active f=focused [left,top,right,bottom]). root: the keyboard window's root, its " +
                    "frame. kb: what the tracker made of it. pill: the button."
            )
            appendLine()
            append(text())
        }
    }

    private fun screenSize(context: Context): Pair<Int, Int> {
        val wm = context.getSystemService(WindowManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && wm != null) {
            val bounds = wm.maximumWindowMetrics.bounds
            return bounds.width() to bounds.height()
        }
        val dm = context.resources.displayMetrics
        return dm.widthPixels to dm.heightPixels
    }
}
