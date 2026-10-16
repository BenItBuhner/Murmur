package app.murmur.android

import app.murmur.android.text.joinPieces
import app.murmur.android.text.joinSeam
import app.murmur.android.text.seamContext
import app.murmur.android.text.stripEcho
import org.junit.Assert.assertEquals
import org.junit.Test

/** Mirrors packages/text-engine/tests/seam.test.ts. */
class SeamTest {
    private fun j(a: String, b: String) = joinSeam(a, b).text

    @Test
    fun `repairs the seams from a real dictation`() {
        assertEquals("Everything that would otherwise be picked up.", j("Everything that would otherwise.", "Otherwise, be picked up."))
        assertEquals("It adds an extra step.", j("It adds a", "An extra step."))
        assertEquals("I want to make this as I'm going to keep it short.", j("I want to make this as.", "I'm going to keep it short."))
        assertEquals("It is literally almost done.", j("It is literally.", "Almost done."))
        assertEquals("It's a question of if we can.", j("It's a question of...", "If we can."))
        assertEquals("We need to really fix it.", j("We need to.", "To really fix it."))
        assertEquals("Every single clip is cut.", j("Every single...", "Clip is cut."))
    }

    @Test
    fun `keeps real boundaries, names and words said twice`() {
        assertEquals("We tried their tools. They suck.", j("We tried their tools.", "They suck."))
        assertEquals("Is it done? Yes it is.", j("Is it done?", "Yes it is."))
        assertEquals("I sent it to Sarah, and she said Sarah was busy.", j("I sent it to.", "Sarah, and she said Sarah was busy."))
        assertEquals("We moved to the API gateway.", j("We moved to the", "API gateway."))
        assertEquals("the build is green now.", j("the build is", "Green now."))
        assertEquals("We shipped it and then it broke.", j("We shipped it.", "and then it broke."))
        assertEquals("I gave it to the end.", j("I gave it to the", "the end."))
        assertEquals("No no, wait.", j("No", "no, wait."))
        assertEquals("A first part of the plan. Done.", joinPieces(listOf("A first part of.", "The plan.", "", "Done.")).text)
    }

    @Test
    fun `gives a short context and drops a copied one`() {
        assertEquals("Honestly I would rather keep the meeting short and", seamContext("It is next week. Honestly I would rather keep the meeting short and"))
        assertEquals("The second one is done.", seamContext("First one. The second one is done."))
        assertEquals("five six seven eight", seamContext("one two three four five six seven eight", 4))
        assertEquals("send the details by email.", stripEcho("Honestly I would rather keep the meeting short and send the details by email.", "Honestly I would rather keep the meeting short and"))
        assertEquals("Send the details by email.", stripEcho("Send the details by email.", "keep the meeting short and"))
        assertEquals("and send it.", stripEcho("and send it.", "short and"))
    }

    /** Mirrors packages/text-engine/tests/seam-oct15.test.ts (Bennett's Oct 15 2026 dictation). */
    @Test
    fun `oct 15 dictation - long echo, near-exact echo, lost periods`() {
        val echo = "that this can achieve under half a second, but as reported,"
        val prev = "I really would prefer $echo"
        val next = "$echo it's completing in roughly 0.8 seconds apparently."
        val joined = joinSeam(prev, next).text
        assertEquals(1, joined.split(echo).size - 1)
        assertEquals("I really would prefer $echo it's completing in roughly 0.8 seconds apparently.", joined)
        assertEquals(
            "it's completing in roughly 0.8 seconds.",
            stripEcho("That this can achieve under half a second, but as reported, it's completing in roughly 0.8 seconds.", "I really would prefer that this can achieve under half a second, but as reported, it")
        )
        assertEquals(
            "and keep the smart ones.",
            stripEcho("We should really move the release tail onto the fast routes by default, and keep the smart ones.", "we should really move the release tail to the fast routes by default")
        )
        assertEquals("to actually transcribe. But it would no doubt be amazing.", j("to actually transcribe", "But it would no doubt be amazing."))
        assertEquals("at all times. And only fast ones.", j("at all times", "And only fast ones."))
        assertEquals("the point stands. Now I've been speaking.", j("the point stands", "Now I've been speaking."))
        assertEquals("I have paused a few times I'm hesitating.", j("I have paused a few times", "I'm hesitating."))
        assertEquals("We met with Sarah and Sarah agreed.", j("We met with Sarah and", "Sarah agreed."))
    }

    @Test
    fun `puts a fragment the cut moved past a stray question mark back`() {
        assertEquals(
            "Can you preview that video for me in this chat? Can I just watch it here, please, or is that not possible?",
            j("Can you preview that video for me in this?", "chat. Can I just watch it here, please, or is that not possible?")
        )
        assertEquals("Is it done? Yes. We shipped it.", j("Is it done?", "Yes. We shipped it."))
    }
}
