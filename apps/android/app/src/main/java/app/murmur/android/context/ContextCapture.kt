package app.murmur.android.context

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

/**
 * All-day context capture on the phone, for Ephemeris's timeline. Android shows a recording indicator for any
 * screen capture, so this never records the screen: it reads the text of the window in front through the
 * accessibility service Murmur already runs, the notifications the phone shows, and which app is in front.
 * Records stay on the phone in a small file until they are sent to an Ephemeris address (POST /api/context).
 */
@Serializable
data class ContextRecord(
    val device: String,
    val at: String,
    val until: String? = null,
    val kind: String,
    val app: String = "",
    val window: String = "",
    val text: String = "",
    val engine: String = "accessibility"
)

/** A node of a window, as far as text extraction cares. Lets the walk run in plain JVM tests. */
interface TextNode {
    val text: CharSequence?
    val contentDescription: CharSequence?
    val isPassword: Boolean
    val isVisible: Boolean
    val childCount: Int
    fun child(i: Int): TextNode?
}

object ScreenText {
    const val MAX_NODES = 600
    const val MAX_CHARS = 8_000

    /** Visible text of a window, top to bottom, without passwords and without repeating a line. */
    fun read(root: TextNode): String {
        val out = LinkedHashSet<String>()
        var seen = 0
        var chars = 0
        val stack = ArrayDeque<TextNode>().apply { add(root) }
        while (stack.isNotEmpty() && seen < MAX_NODES && chars < MAX_CHARS) {
            val n = stack.removeFirst()
            seen++
            if (!n.isVisible || n.isPassword) continue
            val t = (n.text ?: n.contentDescription)?.toString()?.trim().orEmpty()
            if (t.length > 1 && out.add(t)) chars += t.length
            for (i in n.childCount - 1 downTo 0) n.child(i)?.let { stack.addFirst(it) }
        }
        return out.joinToString("\n").take(MAX_CHARS)
    }
}

private class NodeAdapter(private val n: AccessibilityNodeInfo) : TextNode {
    override val text: CharSequence? get() = n.text
    override val contentDescription: CharSequence? get() = n.contentDescription
    override val isPassword: Boolean get() = n.isPassword
    override val isVisible: Boolean get() = n.isVisibleToUser
    override val childCount: Int get() = n.childCount
    override fun child(i: Int): TextNode? = n.getChild(i)?.let(::NodeAdapter)
}

/** Apps whose screens are never read: password managers, banking, authenticators, the lock screen. */
object Privacy {
    private val NEVER = listOf(
        "com.android.systemui", "com.x8bit.bitwarden", "com.agilebits.onepassword", "com.lastpass", "keepass",
        "com.dashlane", "com.google.android.apps.authenticator", "com.azure.authenticator", "bank", "wallet", "pay"
    )
    /** "android" is the system's own dialogs ("App isn't responding"), never worth keeping. */
    fun excluded(pkg: String): Boolean = pkg == "android" || NEVER.any { pkg.contains(it, ignoreCase = true) }
}

object ContextCapture {
    private const val PREFS = "context_capture"
    private const val READ_DELAY_MS = 1_500L
    private const val REREAD_MS = 15_000L
    private const val KEEP_DAYS = 7L
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = false }

    private val _enabled = MutableStateFlow(false)
    val enabled: StateFlow<Boolean> = _enabled
    private val _count = MutableStateFlow(0)
    /** Records waiting on the phone. */
    val count: StateFlow<Int> = _count

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var lastPkg = ""
    private var lastText = ""
    private var app: Context? = null
    private var pendingRead: Runnable? = null

    fun init(context: Context) {
        if (app != null) return
        app = context.applicationContext
        _enabled.value = prefs(context).getBoolean("enabled", false)
        _count.value = runCatching { file(context).readLines().size }.getOrDefault(0)
    }

    fun setEnabled(context: Context, on: Boolean) {
        init(context)
        prefs(context).edit().putBoolean("enabled", on).apply()
        _enabled.value = on
    }

    var endpoint: String
        get() = app?.let { prefs(it).getString("endpoint", "") }.orEmpty()
        set(v) { app?.let { prefs(it).edit().putString("endpoint", v.trim().trimEnd('/')).apply() } }

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun file(c: Context) = File(c.filesDir, "context/records.jsonl").also { it.parentFile?.mkdirs() }
    private fun device() = "android:${android.os.Build.MODEL}"
    private fun worker(): Handler = handler ?: HandlerThread("context-capture").also { it.start(); thread = it }
        .let { Handler(it.looper) }.also { handler = it }

    /**
     * Called by the accessibility service on window changes. Cheap on the main thread: it only schedules a read
     * of the window a moment later, once the screen settled, on a background thread.
     */
    fun onWindowEvent(service: android.accessibilityservice.AccessibilityService, event: AccessibilityEvent) {
        if (!_enabled.value) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOWS_CHANGED) return
        val h = worker()
        pendingRead?.let(h::removeCallbacks)
        val read = Runnable { readNow(service) }
        pendingRead = read
        h.postDelayed(read, READ_DELAY_MS)
    }

    private fun readNow(service: android.accessibilityservice.AccessibilityService) {
        if (!_enabled.value) return
        val root = runCatching { service.rootInActiveWindow }.getOrNull()
        val pkg = root?.packageName?.toString().orEmpty()
        if (root != null && pkg.isNotEmpty() && pkg != service.packageName && !Privacy.excluded(pkg)) {
            val now = Instant.now().toString()
            if (pkg != lastPkg) {
                append(ContextRecord(device(), now, kind = "app", app = pkg))
                lastPkg = pkg
            }
            val text = ScreenText.read(NodeAdapter(root))
            val title = root.paneTitle?.toString() ?: ""
            if (text.isNotBlank() && text != lastText) {
                append(ContextRecord(device(), now, kind = "screen", app = pkg, window = title, text = text))
                lastText = text
            }
        }
        // Scrolling and typing change the screen without a window event: look again while it stays on.
        val h = worker()
        val again = Runnable { readNow(service) }
        pendingRead = again
        h.postDelayed(again, REREAD_MS)
    }

    fun onNotification(context: Context, pkg: String, title: String, text: String) {
        init(context)
        if (!_enabled.value || Privacy.excluded(pkg) || (title.isBlank() && text.isBlank())) return
        append(ContextRecord(device(), Instant.now().toString(), kind = "notification", app = pkg, window = title, text = text, engine = "notification"))
    }

    @Synchronized
    private fun append(r: ContextRecord) {
        val c = app ?: return
        file(c).appendText(json.encodeToString(r) + "\n")
        _count.value += 1
    }

    /** What is waiting, newest last. */
    fun pending(context: Context, limit: Int = 50): List<ContextRecord> =
        runCatching { file(context).readLines().takeLast(limit).map { json.decodeFromString<ContextRecord>(it) } }.getOrDefault(emptyList())

    /** Drops records older than a week, so the file stays small when nothing is sent. */
    @Synchronized
    fun prune(context: Context) {
        val cutoff = Instant.now().minusSeconds(KEEP_DAYS * 86_400).toString()
        val f = file(context)
        val keep = runCatching { f.readLines().filter { json.decodeFromString<ContextRecord>(it).at >= cutoff } }.getOrDefault(emptyList())
        f.writeText(keep.joinToString("") { "$it\n" })
        _count.value = keep.size
    }

    /** Sends everything waiting to Ephemeris and clears it on success. Blocking; call off the main thread. */
    fun upload(context: Context): Result<Int> = runCatching {
        val base = endpoint.ifBlank { error("Set your Ephemeris address first.") }
        val f = file(context)
        val lines = synchronized(this) { f.readLines() }
        if (lines.isEmpty()) return@runCatching 0
        val body = "{\"records\":[" + lines.joinToString(",") + "]}"
        val conn = (URL("$base/api/context").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; doOutput = true; connectTimeout = 10_000; readTimeout = 30_000
            setRequestProperty("content-type", "application/json")
        }
        conn.outputStream.use { it.write(body.toByteArray()) }
        val code = conn.responseCode
        conn.disconnect()
        if (code !in 200..299) error("Ephemeris answered $code.")
        synchronized(this) {
            val now = f.readLines()
            f.writeText(now.drop(lines.size).joinToString("") { "$it\n" })
            _count.value = now.size - lines.size
        }
        lines.size
    }
}
