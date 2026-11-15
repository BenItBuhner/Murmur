package app.murmur.android

import app.murmur.android.context.Privacy
import app.murmur.android.context.ScreenText
import app.murmur.android.context.TextNode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ContextCaptureTest {
    private class N(
        override val text: CharSequence? = null,
        override val contentDescription: CharSequence? = null,
        override val isPassword: Boolean = false,
        override val isVisible: Boolean = true,
        val kids: List<N> = emptyList()
    ) : TextNode {
        override val childCount get() = kids.size
        override fun child(i: Int): TextNode = kids[i]
    }

    @Test fun readsVisibleTextInOrderWithoutPasswordsOrRepeats() {
        val root = N(kids = listOf(
            N("Inbox"),
            N(kids = listOf(N("Dana: pricing review at 3"), N("hunter2", isPassword = true))),
            N("Hidden", isVisible = false),
            N(contentDescription = "Compose"),
            N("Inbox")
        ))
        assertEquals("Inbox\nDana: pricing review at 3\nCompose", ScreenText.read(root))
    }

    @Test fun capsHugeWindows() {
        val root = N(kids = List(5_000) { N("line number $it with some words") })
        assertTrue(ScreenText.read(root).length <= ScreenText.MAX_CHARS)
    }

    @Test fun skipsPrivateApps() {
        assertTrue(Privacy.excluded("com.x8bit.bitwarden"))
        assertTrue(Privacy.excluded("com.chase.sig.android.bank"))
        assertTrue(Privacy.excluded("android"))
        assertFalse(Privacy.excluded("com.android.settings"))
        assertFalse(Privacy.excluded("com.slack"))
    }
}
