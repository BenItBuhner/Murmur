package app.murmur.android

import app.murmur.android.text.Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors packages/text-engine/tests/repair.test.ts. */
class RepairTest {
    @Test
    fun saysADoubledRunOnce() {
        assertEquals(
            "For more information, or to volunteer, please visit LIBRIVOX.org.",
            Verify.repairOutput(
                "for more information or to volunteer please visit librivox.org",
                "For more information, or to volunteer, please visit LIBRIVOX.org LIBRIVOX.org."
            )
        )
    }

    @Test
    fun keepsSpokenRepetitionAndNumbers() {
        assertEquals("No, no, no, not that one.", Verify.repairOutput("no no no not that one", "No, no, no, not that one."))
        assertEquals("5,000, 5,000", Verify.repairOutput("five thousand five thousand", "5,000, 5,000"))
    }

    @Test
    fun joinsUndictatedBreaksButKeepsLayout() {
        assertEquals(
            "The cat sat on the mat. And then it slept.",
            Verify.repairOutput("the cat sat on the mat and then it slept", "The cat sat on the mat.\n\nAnd then it slept.")
        )
        assertEquals("Hello there.\nHow are you?", Verify.repairOutput("hello there new line how are you", "Hello there.\nHow are you?"))
        assertEquals("1. Buy milk\n2. Buy eggs", Verify.repairOutput("first buy milk second buy eggs", "1. Buy milk\n2. Buy eggs"))
    }

    @Test
    fun rejectsASentenceSaidTwice() {
        val t = "this is a librivox recording all librivox recordings are in the public domain"
        val o = "This is a LibriVox recording. All LibriVox recordings are in the public domain. This is a LibriVox recording."
        val v = Verify.verifyOutput(t, o)
        assertFalse(v.ok)
        assertEquals("repeated", v.reason)
        assertTrue(Verify.verifyOutput("we need to ship it we need to ship it today", "We need to ship it. We need to ship it today.").ok)
    }
}
