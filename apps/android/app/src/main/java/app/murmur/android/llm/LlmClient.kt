package app.murmur.android.llm

import app.murmur.android.stt.SttErrorKind
import app.murmur.android.stt.SttException
import app.murmur.android.stt.classifyStatus
import app.murmur.android.stt.normalizeBaseUrl
import app.murmur.android.stt.parseErrorBody
import app.murmur.android.stt.toSttException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class LlmConfig(
    val baseUrl: String,
    val apiKey: String,
    val model: String,
    val timeoutMs: Int
)

data class ChatMessage(val role: String, val content: String)

data class ChatResult(
    val text: String,
    val latencyMs: Long,
    val model: String,
    val finishReason: String? = null
)

/** Minimal OpenAI-compatible chat completion client; port of apps/desktop/src/core/llm/client.ts. */
object LlmClient {
    private val baseClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()

    private fun client(timeoutMs: Int): OkHttpClient = baseClient.newBuilder()
        .callTimeout(timeoutMs.toLong().coerceAtLeast(1000), TimeUnit.MILLISECONDS)
        .readTimeout(timeoutMs.toLong().coerceAtLeast(1000), TimeUnit.MILLISECONDS)
        .build()

    suspend fun chatComplete(
        cfg: LlmConfig,
        messages: List<ChatMessage>,
        temperature: Double = 0.0,
        maxTokens: Int = 512
    ): ChatResult = withContext(Dispatchers.IO) {
        val base = normalizeBaseUrl(cfg.baseUrl)
        if (base.isEmpty()) throw SttException("No LLM base URL configured", SttErrorKind.BAD_REQUEST)
        if (cfg.model.isEmpty()) throw SttException("No LLM model selected", SttErrorKind.MODEL)
        val payload = JSONObject()
            .put("model", cfg.model)
            .put(
                "messages",
                JSONArray().apply {
                    for (m in messages) put(JSONObject().put("role", m.role).put("content", m.content))
                }
            )
            .put("temperature", temperature)
            .put("max_tokens", maxTokens)
            .put("stream", false)
        val req = Request.Builder()
            .url("$base/chat/completions")
            .header("Content-Type", "application/json")
            .apply { if (cfg.apiKey.isNotEmpty()) header("Authorization", "Bearer ${cfg.apiKey}") }
            .post(payload.toString().toRequestBody("application/json".toMediaType()))
            .build()
        val started = System.nanoTime()
        try {
            client(cfg.timeoutMs).newCall(req).execute().use { r ->
                if (!r.isSuccessful) {
                    val (message, suggested) = parseErrorBody(r.body?.string() ?: "")
                    throw SttException(
                        message.ifEmpty { "HTTP ${r.code}" },
                        classifyStatus(r.code, message), r.code, suggested
                    )
                }
                val json = JSONObject(r.body?.string() ?: "{}")
                val choice = json.optJSONArray("choices")?.optJSONObject(0)
                val content = choice?.optJSONObject("message")?.opt("content")
                val text = when (content) {
                    is String -> content
                    is JSONArray -> buildString {
                        for (i in 0 until content.length())
                            append(content.optJSONObject(i)?.optString("text") ?: "")
                    }
                    else -> ""
                }
                ChatResult(
                    text = text,
                    latencyMs = (System.nanoTime() - started) / 1_000_000,
                    model = json.optString("model", cfg.model),
                    finishReason = choice?.optString("finish_reason")?.takeIf { it.isNotEmpty() }
                )
            }
        } catch (e: Exception) {
            throw toSttException(e, "Formatting request failed")
        }
    }

    suspend fun listModels(baseUrl: String, apiKey: String): List<String> = withContext(Dispatchers.IO) {
        val base = normalizeBaseUrl(baseUrl)
        if (base.isEmpty()) throw SttException("No LLM base URL configured", SttErrorKind.BAD_REQUEST)
        val req = Request.Builder().url("$base/models").apply {
            if (apiKey.isNotEmpty()) header("Authorization", "Bearer $apiKey")
        }.build()
        try {
            client(15_000).newCall(req).execute().use { r ->
                if (!r.isSuccessful) {
                    val (message, _) = parseErrorBody(r.body?.string() ?: "")
                    throw SttException(
                        message.ifEmpty { "HTTP ${r.code}" },
                        classifyStatus(r.code, message), r.code
                    )
                }
                val json = JSONObject(r.body?.string() ?: "{}")
                val ids = ArrayList<String>()
                val data = json.optJSONArray("data")
                if (data != null) for (i in 0 until data.length()) {
                    val id = data.optJSONObject(i)?.optString("id") ?: continue
                    if (id.isNotEmpty()) ids.add(id)
                }
                // Chat models first: speech/embedding/etc. models sink to the bottom.
                fun score(id: String): Int =
                    if (Regex("whisper|stt|transcri|tts|embed|image|rerank|moderation|audio|scribe", RegexOption.IGNORE_CASE)
                            .containsMatchIn(id)
                    ) 1 else 0
                ids.distinct().sortedWith(compareBy({ score(it) }, { it }))
            }
        } catch (e: Exception) {
            throw toSttException(e, "Could not list models")
        }
    }
}
