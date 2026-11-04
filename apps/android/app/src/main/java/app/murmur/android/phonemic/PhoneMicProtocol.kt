package app.murmur.android.phonemic

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject

/**
 * Phone as microphone (docs/phone-microphone.md): the Android port of
 * packages/backend/convex/lib/micProtocol.ts. Keep the constants, the messages and the Opus tuning
 * in step with that file (PhoneMicProtocolTest pins the behaviour to the same cases).
 */
object PhoneMicProtocol {
    const val VERSION = 1
    const val ICE_GATHER_MS = 3_000L
    const val ANSWER_TIMEOUT_MS = 20_000L
    const val CONTROL_LABEL = "murmur-control"
    const val MAX_NAME_LENGTH = 120
    const val RESULT_PREVIEW = 280

    val OPUS_PARAMS: List<Pair<String, String>> = listOf(
        "stereo" to "0",
        "sprop-stereo" to "0",
        "useinbandfec" to "1",
        "usedtx" to "0",
        "maxaveragebitrate" to "32000"
    )

    private val RTPMAP_OPUS = Regex("^a=rtpmap:(\\d+) opus/48000", RegexOption.IGNORE_CASE)
    private val FMTP = Regex("^a=fmtp:(\\d+) (.*)$")

    /** Opus tuned for speech going to a recognizer: mono, in-band FEC, no DTX, 32 kbit/s. */
    fun tuneOpusSdp(sdp: String): String {
        val eol = if (sdp.contains("\r\n")) "\r\n" else "\n"
        val lines = sdp.split(Regex("\r?\n"))
        val opus = lines.mapNotNull { RTPMAP_OPUS.find(it)?.groupValues?.get(1) }.toSet()
        if (opus.isEmpty()) return sdp
        val seen = mutableSetOf<String>()
        val tuned = lines.map { line ->
            val m = FMTP.find(line)
            if (m == null || m.groupValues[1] !in opus) return@map line
            val pt = m.groupValues[1]
            seen += pt
            val params = LinkedHashMap<String, String>()
            for (part in m.groupValues[2].split(';')) {
                val kv = part.trim().split('=')
                if (kv[0].isNotEmpty()) params[kv[0]] = kv.drop(1).joinToString("=")
            }
            for ((k, v) in OPUS_PARAMS) params[k] = v
            "a=fmtp:$pt " + params.entries.joinToString(";") { "${it.key}=${it.value}" }
        }
        val out = ArrayList<String>(tuned.size + 1)
        for (line in tuned) {
            out += line
            val pt = RTPMAP_OPUS.find(line)?.groupValues?.get(1)
            if (pt != null && pt !in seen) {
                out += "a=fmtp:$pt " + OPUS_PARAMS.joinToString(";") { "${it.first}=${it.second}" }
            }
        }
        return out.joinToString(eol)
    }

    fun hello(name: String): String =
        JsonObject(
            mapOf(
                "t" to JsonPrimitive("hello"),
                "v" to JsonPrimitive(VERSION),
                "name" to JsonPrimitive(name.take(MAX_NAME_LENGTH))
            )
        ).toString()

    /** `start`, `stop`, `cancel` or `ping`. */
    fun command(t: String): String = JsonObject(mapOf("t" to JsonPrimitive(t))).toString()

    fun parseDesktop(raw: String): DesktopMessage? {
        if (raw.length > 4_096) return null
        val obj = runCatching { Json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return null
        fun str(key: String): String? = (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        fun num(key: String): Double? = (obj[key] as? JsonPrimitive)?.takeIf { !it.isString && it.booleanOrNull == null }?.doubleOrNull
        fun state(): DictationState? = when (str("state")) {
            "idle" -> DictationState.IDLE
            "listening" -> DictationState.LISTENING
            "processing" -> DictationState.PROCESSING
            else -> null
        }
        return when (str("t")) {
            "welcome" -> state()?.let {
                DesktopMessage.Welcome(num("v")?.toInt() ?: 0, str("name")?.take(MAX_NAME_LENGTH) ?: "Desktop", it)
            }
            "state" -> state()?.let { DesktopMessage.State(it, num("elapsedSec")?.toInt()) }
            "level" -> num("level")?.let { DesktopMessage.Level(it.coerceIn(0.0, 1.0).toFloat()) }
            "result" -> str("text")?.let { DesktopMessage.Result(it.take(RESULT_PREVIEW), num("words")?.toInt() ?: 0) }
            "error" -> str("message")?.let { DesktopMessage.Error(it.take(300)) }
            "pong" -> DesktopMessage.Pong
            else -> null
        }
    }
}

enum class DictationState { IDLE, LISTENING, PROCESSING }

sealed class DesktopMessage {
    data class Welcome(val version: Int, val name: String, val state: DictationState) : DesktopMessage()
    data class State(val state: DictationState, val elapsedSec: Int?) : DesktopMessage()
    data class Level(val level: Float) : DesktopMessage()
    data class Result(val text: String, val words: Int) : DesktopMessage()
    data class Error(val message: String) : DesktopMessage()
    data object Pong : DesktopMessage()
}
