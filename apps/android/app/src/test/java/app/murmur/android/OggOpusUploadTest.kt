package app.murmur.android

import app.murmur.android.audio.OggOpus
import app.murmur.android.settings.SttKind
import app.murmur.android.stt.SttClient
import app.murmur.android.stt.SttConfig
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Ogg packaging and the gateway-only Opus upload. Mirrors apps/desktop/tests/ogg-opus.test.ts. */
class OggOpusUploadTest {
    private val server = MockWebServer()
    private val wav = ByteArray(64)
    private val fakeOgg = "OggS-fake".toByteArray()

    @Before
    fun start() {
        server.start()
        SttClient.compactEncoder = { fakeOgg }
    }

    @After
    fun stop() {
        server.shutdown()
        SttClient.compactEncoder = OggOpus::fromWav
    }

    private fun cfg(speed: String?) = SttConfig(
        kind = SttKind.OPENAI_COMPATIBLE,
        baseUrl = "http://${server.hostName}:${server.port}/v1",
        apiKey = "",
        model = "murmur-transcribe",
        language = "auto",
        timeoutMs = 5_000,
        speed = speed
    )

    private fun answer(code: Int, body: String) {
        server.enqueue(MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body))
    }

    private fun sentType(): String = Regex("filename=\"audio\\.(\\w+)\"").find(server.takeRequest().body.readUtf8())!!.groupValues[1]

    @Test
    fun `pages carry the clip length in the last granule`() {
        val file = OggOpus.mux(List(120) { ByteArray(40) { 7 } })
        assertEquals("OggS", String(file, 0, 4, Charsets.US_ASCII))
        assertEquals("OpusHead", String(file, 28, 8, Charsets.US_ASCII))
        var at = 0
        var last = 0
        while (at < file.size) {
            last = at
            val n = file[at + 26].toInt() and 0xff
            var body = 0
            for (i in 0 until n) body += file[at + 27 + i].toInt() and 0xff
            at += 27 + n + body
        }
        assertEquals(file.size, at)
        assertEquals(0x04, file[last + 5].toInt())
        val granule = ByteBuffer.wrap(file, last + 6, 8).order(ByteOrder.LITTLE_ENDIAN).long
        assertEquals(312L + 120 * 960, granule)
    }

    @Test
    fun `only the Murmur gateway gets Opus`() = runBlocking {
        answer(200, """{"text":"a"}""")
        answer(200, """{"text":"b"}""")
        SttClient.transcribe(wav, null, cfg("fast"))
        assertEquals("ogg", sentType())
        SttClient.transcribe(wav, null, cfg(null))
        assertEquals("wav", sentType())
    }

    @Test
    fun `a gateway that refuses Opus gets the WAV`() = runBlocking {
        answer(400, """{"error":{"message":"could not decode audio"}}""")
        answer(200, """{"text":"ok"}""")
        val out = SttClient.transcribe(wav, null, cfg("normal"))
        assertEquals("ok", out.text)
        assertEquals("ogg", sentType())
        assertEquals("wav", sentType())
        assertTrue(server.requestCount == 2)
    }
}
