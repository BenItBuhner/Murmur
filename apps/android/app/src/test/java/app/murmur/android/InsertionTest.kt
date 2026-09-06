package app.murmur.android

import app.murmur.android.text.Splice
import app.murmur.android.text.spliceAtSelection
import org.junit.Assert.assertEquals
import org.junit.Test

class InsertionTest {
    @Test
    fun `appends to an empty field`() {
        assertEquals(Splice("Hello world ", 12), spliceAtSelection("", 0, 0, "Hello world "))
    }

    @Test
    fun `inserts at a collapsed caret in the middle`() {
        assertEquals(Splice("Hello there friend", 11), spliceAtSelection("Hello  friend", 6, 6, "there"))
    }

    @Test
    fun `replaces the selected range`() {
        assertEquals(Splice("Send it Wednesday", 17), spliceAtSelection("Send it Tuesday", 8, 15, "Wednesday"))
    }

    @Test
    fun `reversed selection is normalised`() {
        assertEquals(Splice("Send it Wednesday", 17), spliceAtSelection("Send it Tuesday", 15, 8, "Wednesday"))
    }

    @Test
    fun `missing selection appends at the end`() {
        assertEquals(Splice("abc xyz", 7), spliceAtSelection("abc", -1, -1, " xyz"))
    }

    @Test
    fun `stale offsets beyond the text append at the end`() {
        assertEquals(Splice("abc!", 4), spliceAtSelection("abc", 10, 12, "!"))
    }

    @Test
    fun `an end offset past the text collapses to the start offset`() {
        assertEquals(Splice("ab!c", 3), spliceAtSelection("abc", 2, 99, "!"))
    }
}
