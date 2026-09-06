package app.murmur.android.text

/** Field content after a dictation was spliced in, plus where the caret belongs afterwards. */
data class Splice(val text: String, val caret: Int)

/**
 * Insert [insert] into [existing] at the current selection, replacing whatever was selected.
 *
 * Selection offsets arrive the way accessibility nodes report them: -1 when the field has no
 * selection, sometimes stale or reversed. Anything unusable falls back to appending at the end,
 * which is what the user expects when they tap a field and dictate.
 */
fun spliceAtSelection(existing: String, selectionStart: Int, selectionEnd: Int, insert: String): Splice {
    var start = selectionStart
    var end = selectionEnd
    if (start < 0 || start > existing.length) start = existing.length
    if (end < 0 || end > existing.length) end = start
    if (end < start) {
        val t = start
        start = end
        end = t
    }
    val text = existing.substring(0, start) + insert + existing.substring(end)
    return Splice(text, start + insert.length)
}
