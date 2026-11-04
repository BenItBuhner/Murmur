package app.murmur.android.phonemic

import app.murmur.android.ui.clockLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors packages/backend/tests/micLink.test.ts, so the phone and the desktop speak the same protocol. */
class PhoneMicProtocolTest {
    @Test
    fun `tunes Opus for speech and keeps other parameters`() {
        val sdp = listOf(
            "v=0",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
            "a=rtpmap:111 opus/48000/2",
            "a=fmtp:111 minptime=10;useinbandfec=0;stereo=1",
            "a=rtpmap:63 red/48000/2",
            "a=fmtp:63 111/111",
            ""
        ).joinToString("\r\n")
        val tuned = PhoneMicProtocol.tuneOpusSdp(sdp)
        assertTrue(tuned, tuned.contains("a=fmtp:111 minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;usedtx=0;maxaveragebitrate=32000"))
        assertTrue(tuned.contains("a=fmtp:63 111/111"))
        assertEquals(sdp.split("\r\n").size, tuned.split("\r\n").size)
        assertEquals(tuned, PhoneMicProtocol.tuneOpusSdp(tuned))
        assertEquals(
            "v=0\na=rtpmap:96 opus/48000/2\na=fmtp:96 stereo=0;sprop-stereo=0;useinbandfec=1;usedtx=0;maxaveragebitrate=32000\n",
            PhoneMicProtocol.tuneOpusSdp("v=0\na=rtpmap:96 opus/48000/2\n")
        )
        assertEquals("v=0\r\n", PhoneMicProtocol.tuneOpusSdp("v=0\r\n"))
    }

    @Test
    fun `writes phone messages the desktop accepts`() {
        assertEquals("""{"t":"hello","v":1,"name":"Pixel 9"}""", PhoneMicProtocol.hello("Pixel 9"))
        assertEquals("""{"t":"start"}""", PhoneMicProtocol.command("start"))
    }

    @Test
    fun `parses desktop messages strictly`() {
        assertEquals(
            DesktopMessage.Welcome(1, "Studio", DictationState.IDLE),
            PhoneMicProtocol.parseDesktop("""{"t":"welcome","v":1,"name":"Studio","state":"idle"}""")
        )
        assertEquals(
            DesktopMessage.State(DictationState.LISTENING, 3),
            PhoneMicProtocol.parseDesktop("""{"t":"state","state":"listening","elapsedSec":3}""")
        )
        assertEquals(DesktopMessage.Level(1f), PhoneMicProtocol.parseDesktop("""{"t":"level","level":4}"""))
        assertEquals(DesktopMessage.Result("hi there", 2), PhoneMicProtocol.parseDesktop("""{"t":"result","text":"hi there","words":2}"""))
        assertEquals(DesktopMessage.Pong, PhoneMicProtocol.parseDesktop("""{"t":"pong"}"""))
        assertNull(PhoneMicProtocol.parseDesktop("""{"t":"state","state":"dancing"}"""))
        assertNull(PhoneMicProtocol.parseDesktop("""{"t":"level","level":"loud"}"""))
        assertNull(PhoneMicProtocol.parseDesktop("nope"))
        assertNull(PhoneMicProtocol.parseDesktop("[1]"))
        assertNull(PhoneMicProtocol.parseDesktop("x".repeat(5000)))
    }

    @Test
    fun `the clock reads minutes, then hours for long sessions`() {
        assertEquals("0:07", clockLabel(7))
        assertEquals("31:05", clockLabel(31 * 60 + 5))
        assertEquals("1:02:09", clockLabel(3729))
    }
}
