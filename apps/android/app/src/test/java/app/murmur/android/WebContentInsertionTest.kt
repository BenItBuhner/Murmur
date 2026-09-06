package app.murmur.android

import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
import app.murmur.android.service.EXTRA_CHROME_ROLE
import app.murmur.android.service.EditableTarget
import app.murmur.android.service.InsertOutcome
import app.murmur.android.service.NodeTarget
import app.murmur.android.service.TextInserter
import app.murmur.android.service.WEB_ACTIVATION_SETTLE_MS
import app.murmur.android.service.WEB_VIEW_CLASS_NAME
import app.murmur.android.service.acceptsText
import app.murmur.android.service.isWebContent
import app.murmur.android.service.retryLookup
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The node-level side of insertion: recognising fields that belong to a web page (a browser tab, an
 * installed PWA, a WebView) from what their [AccessibilityNodeInfo] looks like, and routing them to
 * the clipboard instead of `ACTION_SET_TEXT`, with the user-activation click Chrome needs before it
 * lets the page read that clipboard. Nodes are built the way the engines build them.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@Suppress("DEPRECATION") // AccessibilityNodeInfo.obtain() is what Robolectric shadows; the constructor is not.
class WebContentInsertionTest {

    /** What Chromium hands out for a focused `<div contenteditable>` chat composer. */
    private fun chromiumComposer(): AccessibilityNodeInfo = AccessibilityNodeInfo.obtain().apply {
        className = "android.widget.EditText"
        packageName = "com.android.chrome"
        isEditable = true
        isFocused = true
        isMultiLine = true
        // Every focusable node is clickable to Chromium; the click is what TalkBack's double-tap sends.
        isClickable = true
        // The role stays the DOM role; only the class name is promoted to EditText.
        extras.putCharSequence(EXTRA_CHROME_ROLE, "genericContainer")
        extras.putCharSequence("AccessibilityNodeInfo.hint", "")
        // For a rich editor the node text is the rendered subtree, placeholder included.
        text = "Message #general"
        setTextSelection(0, 0)
        addAction(AccessibilityAction.ACTION_CLICK)
        addAction(AccessibilityAction.ACTION_SET_TEXT)
        addAction(AccessibilityAction.ACTION_PASTE)
        addAction(AccessibilityAction.ACTION_IME_ENTER)
    }

    private fun nativeField(parents: List<String> = listOf("android.widget.FrameLayout", "android.widget.LinearLayout")): AccessibilityNodeInfo {
        val field = AccessibilityNodeInfo.obtain().apply {
            className = "android.widget.EditText"
            packageName = "com.whatsapp"
            isEditable = true
            text = "Hello "
            setTextSelection(6, 6)
        }
        var child = field
        for (name in parents) {
            val parent = AccessibilityNodeInfo.obtain().apply { className = name; packageName = "com.whatsapp" }
            shadowOf(parent).addChild(child)
            child = parent
        }
        return field
    }

    @Test
    fun `a Chromium node is web content because of the role it carries in its extras`() {
        assertTrue(chromiumComposer().isWebContent())
    }

    @Test
    fun `a field under a WebView document root is web content even without Chromium extras`() {
        val field = AccessibilityNodeInfo.obtain().apply {
            className = "android.widget.EditText"
            isEditable = true
        }
        val paragraph = AccessibilityNodeInfo.obtain().apply { className = "android.view.View" }
        val document = AccessibilityNodeInfo.obtain().apply { className = WEB_VIEW_CLASS_NAME }
        val decor = AccessibilityNodeInfo.obtain().apply { className = "android.widget.FrameLayout" }
        shadowOf(paragraph).addChild(field)
        shadowOf(document).addChild(paragraph)
        shadowOf(decor).addChild(document)

        assertTrue(field.isWebContent())
    }

    @Test
    fun `a native EditText inside ordinary layouts is not web content`() {
        assertFalse(nativeField().isWebContent())
        assertFalse(nativeField(parents = emptyList()).isWebContent())
    }

    @Test
    fun `a page editor is clicked for user activation and pasted into, and SET_TEXT is never sent`() = runTest {
        val node = chromiumComposer()
        val clipboard = ArrayList<String>()

        val outcome = TextInserter.insert(NodeTarget(node), "Hello world ", pressEnter = false) { clipboard.add(it) }

        assertEquals(InsertOutcome.Inserted("paste"), outcome)
        assertEquals(listOf("Hello world "), clipboard)
        // Chrome pastes an empty string (and still reports success) unless the page had a gesture
        // in the last five seconds; ACTION_CLICK is NotifyUserActivation + refocus in Blink.
        assertEquals(
            listOf(AccessibilityNodeInfo.ACTION_CLICK, AccessibilityNodeInfo.ACTION_PASTE),
            shadowOf(node).performedActions
        )
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `the paste waits for the page to settle after the activation click`() = runTest {
        val node = chromiumComposer()
        val pastedAt = ArrayList<Long>()
        val target = object : EditableTarget by NodeTarget(node) {
            override fun performAction(action: Int, arguments: Bundle?): Boolean {
                if (action == AccessibilityNodeInfo.ACTION_PASTE) pastedAt.add(testScheduler.currentTime)
                return node.performAction(action, arguments)
            }
        }

        TextInserter.insert(target, "Hello world ", pressEnter = false) { }

        assertEquals(listOf(WEB_ACTIVATION_SETTLE_MS), pastedAt)
    }

    @Test
    fun `press enter on a page editor uses the IME action Chromium implements`() = runTest {
        val node = chromiumComposer()

        TextInserter.insert(NodeTarget(node), "Hello world", pressEnter = true) { }

        assertEquals(
            listOf(
                AccessibilityNodeInfo.ACTION_CLICK,
                AccessibilityNodeInfo.ACTION_PASTE,
                AccessibilityAction.ACTION_IME_ENTER.id
            ),
            shadowOf(node).performedActions
        )
    }

    @Test
    fun `a native field is still written with SET_TEXT and leaves the clipboard alone`() = runTest {
        val node = nativeField()
        val clipboard = ArrayList<String>()

        val outcome = TextInserter.insert(NodeTarget(node), "world", pressEnter = false) { clipboard.add(it) }

        assertEquals(InsertOutcome.Inserted("set-text"), outcome)
        assertTrue(clipboard.isEmpty())
        val performed = shadowOf(node).performedActionsWithArgs
        assertEquals(AccessibilityNodeInfo.ACTION_SET_TEXT, performed.single().first)
        assertEquals(
            "Hello world",
            performed.single().second.getCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE).toString()
        )
    }

    @Test
    fun `a node that cannot be refreshed is treated as a missing field`() = runTest {
        val node = chromiumComposer()
        shadowOf(node).setRefreshReturnValue(false)
        val clipboard = ArrayList<String>()

        val outcome = TextInserter.insert(NodeTarget(node), "Hello", pressEnter = false) { clipboard.add(it) }

        assertEquals(InsertOutcome.Failed("Copied — tap a text field and paste"), outcome)
        assertEquals(listOf("Hello"), clipboard)
        assertTrue(shadowOf(node).performedActions.isEmpty())
    }

    @Test
    fun `acceptsText follows the advertised actions when a field is not flagged editable`() {
        val pasteOnly = AccessibilityNodeInfo.obtain().apply { addAction(AccessibilityAction.ACTION_PASTE) }
        val setTextOnly = AccessibilityNodeInfo.obtain().apply { addAction(AccessibilityAction.ACTION_SET_TEXT) }
        val readOnly = AccessibilityNodeInfo.obtain().apply { addAction(AccessibilityAction.ACTION_COPY) }

        assertTrue(pasteOnly.acceptsText())
        assertTrue(setTextOnly.acceptsText())
        assertFalse(readOnly.acceptsText())
        assertTrue(chromiumComposer().acceptsText())
    }

    @Test
    fun `retryLookup returns the first answer and stops`() = runTest {
        var calls = 0
        val found = retryLookup(5, 90) { attempt ->
            calls++
            if (attempt == 2) "field" else null
        }
        assertEquals("field", found)
        assertEquals(3, calls)
    }

    @Test
    fun `retryLookup gives up after the last attempt`() = runTest {
        var calls = 0
        val found = retryLookup(5, 90) { calls++; null }
        assertNull(found)
        assertEquals(5, calls)
    }
}
