package app.murmur.android

import app.murmur.android.text.joinPauseStops
import app.murmur.android.text.prepareTranscript
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors packages/text-engine/tests/pause-stops.test.ts. */
class PauseStopsTest {
    @Test
    fun `joins a sentence that ends where no sentence can`() {
        assertEquals("I also want to stop measuring the day.", joinPauseStops("I also want to. Stop measuring the day."))
        assertEquals("It is a lot of stuff to do.", joinPauseStops("It is a lot of. Stuff to do."))
        assertEquals("I could not reproduce it on Linux.", joinPauseStops("I could. Not reproduce it on Linux."))
    }

    @Test
    fun `keeps a capital it cannot vouch for`() {
        assertEquals("Send the budget to Sarah by Friday.", joinPauseStops("Send the budget to. Sarah by Friday."))
        assertEquals("Talk to I mean, ask her.", joinPauseStops("Talk to. I mean, ask her."))
    }

    @Test
    fun `leaves real sentence ends alone`() {
        for (s in listOf(
            "Nobody will. I also want to go.",
            "I wish I could. Not today though.",
            "We went with plan A. Then it rained.",
            "Wait for it... The window.",
            "Is it done? The build is red."
        )) assertEquals(s, joinPauseStops(s))
    }

    @Test
    fun `runs before formatting, and is a stage`() {
        val p = prepareTranscript("I want to. Stop measuring.")
        assertEquals("I want to stop measuring.", p.text)
        assertTrue("pause-stops" in p.stages)
    }
}
