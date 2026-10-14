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
}
