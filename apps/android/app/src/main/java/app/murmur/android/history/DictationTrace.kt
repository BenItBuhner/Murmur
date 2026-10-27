package app.murmur.android.history

import kotlinx.serialization.Serializable
import org.json.JSONObject
import java.util.Collections

/**
 * Where one dictation's time went, kept with its History entry so a slow or odd dictation can be
 * explained after the fact (Oct 24 2026: a ~30 s dictation that nothing on the phone could
 * account for). No text, no tokens: stage names, durations and which of the instance's models
 * answered. History shows it under the entry and copies it as plain text for a bug report.
 */
@Serializable
data class DictationTrace(
    /** How the speech came back: `whole`, `streamed` (pieces + tail), `one-call` or `retry`. */
    val path: String = "",
    /** Stages at release, in the order they finished. */
    val steps: List<TraceStep> = emptyList(),
    /** What the Murmur gateway reported for each request made at release. */
    val calls: List<GatewayCall> = emptyList(),
    /** Anything that took the dictation off its quickest path. */
    val notes: List<String> = emptyList(),
    /** Pieces transcribed while the user was still speaking. */
    val pieces: Int = 0
) {
    /** The stage that took longest, for History's one-line summary. */
    val slowest: TraceStep? get() = steps.maxByOrNull { it.ms }

    /** Plain text for the clipboard. */
    fun describe(): String = buildString {
        append("path: ").append(path.ifEmpty { "?" })
        if (pieces > 0) append(" (").append(pieces).append(" piece").append(if (pieces == 1) "" else "s").append(" while speaking)")
        append('\n')
        for (s in steps) append("  ").append(s.name).append(": ").append(s.ms).append(" ms\n")
        for (c in calls) append("  ").append(c.describe()).append('\n')
        for (n in notes) append("  note: ").append(n).append('\n')
    }.trimEnd()
}

@Serializable
data class TraceStep(val name: String, val ms: Long)

/**
 * One request as the gateway described it (`x-murmur-trace`, or the `trace` / `timing` fields of
 * `/v1/format` and `/v1/dictate/release`): the role of the model that answered (`fast`, `normal`,
 * `hedge`, `background`), its time on the server, and whether a second model had to be asked.
 */
@Serializable
data class GatewayCall(
    val stage: String,
    val role: String,
    val ms: Long,
    val ok: Boolean = true,
    val hedged: Boolean = false,
    val failover: Boolean = false,
    val attempts: Int = 1,
    val error: String? = null
) {
    fun describe(): String = buildString {
        append(stage).append(" on the gateway: ").append(ms).append(" ms, ").append(role).append(" model")
        if (failover) append(", failed over")
        else if (hedged) append(", hedged")
        if (attempts > 1) append(", ").append(attempts).append(" attempts")
        if (!ok) append(", failed").append(error?.let { " ($it)" } ?: "")
    }

    companion object {
        /** A gateway trace object, or null when the server sent none (older gateways, own providers). */
        fun parse(stage: String, json: JSONObject?): GatewayCall? {
            if (json == null || !json.has("role")) return null
            return GatewayCall(
                stage = stage,
                role = json.optString("role", "?"),
                ms = json.optLong("ms", 0),
                ok = json.optBoolean("ok", true),
                hedged = json.optBoolean("hedged", false),
                failover = json.optBoolean("failover", false),
                attempts = json.optInt("attempts", 1).coerceAtLeast(1),
                error = json.optString("error").takeIf { json.has("error") && !json.isNull("error") }
            )
        }

        /** The `x-murmur-trace` header. */
        fun fromHeader(stage: String, header: String?): GatewayCall? =
            header?.let { runCatching { parse(stage, JSONObject(it)) }.getOrNull() }

        /** The calls of a `/v1/format` answer's `trace`. */
        fun fromFormat(json: JSONObject?): List<GatewayCall> {
            val calls = json?.optJSONObject("trace")?.optJSONArray("calls") ?: return emptyList()
            return (0 until calls.length()).mapNotNull { parse("format", calls.optJSONObject(it)) }
        }
    }
}

/** Collects a [DictationTrace] while the release runs on several coroutines. */
class TraceRecorder(var path: String = "") {
    private val steps = Collections.synchronizedList(ArrayList<TraceStep>())
    private val calls = Collections.synchronizedList(ArrayList<GatewayCall>())
    private val notes = Collections.synchronizedList(ArrayList<String>())
    @Volatile var pieces = 0

    fun step(name: String, ms: Long) {
        steps.add(TraceStep(name, ms.coerceAtLeast(0)))
    }

    /** Time [block] and record it as [name]. */
    inline fun <T> timed(name: String, block: () -> T): T {
        val started = System.currentTimeMillis()
        try {
            return block()
        } finally {
            step(name, System.currentTimeMillis() - started)
        }
    }

    fun call(call: GatewayCall?) {
        if (call != null) calls.add(call)
    }

    fun calls(list: List<GatewayCall>) {
        calls.addAll(list)
    }

    fun note(text: String) {
        if (text.isNotBlank() && notes.size < 12) notes.add(text.take(200))
    }

    fun build(): DictationTrace = DictationTrace(
        path = path,
        steps = synchronized(steps) { steps.toList() },
        calls = synchronized(calls) { calls.toList() },
        notes = synchronized(notes) { notes.toList() },
        pieces = pieces
    )
}
