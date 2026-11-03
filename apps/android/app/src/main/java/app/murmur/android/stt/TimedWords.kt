package app.murmur.android.stt

import org.json.JSONObject

/** One transcribed word and where it sits in the clip, in seconds. */
data class TimedWord(val word: String, val start: Double, val end: Double)

/** The `words` of a verbose transcription answer, or null when any word lacks its text or timing. */
fun wordsFromVerbose(json: JSONObject): List<TimedWord>? {
    val array = json.optJSONArray("words") ?: return null
    if (array.length() == 0) return null
    val out = ArrayList<TimedWord>(array.length())
    for (i in 0 until array.length()) {
        val o = array.optJSONObject(i) ?: return null
        val word = o.opt("word") as? String ?: return null
        val start = o.optDouble("start")
        val end = o.optDouble("end")
        if (start.isNaN() || end.isNaN()) return null
        out.add(TimedWord(word, start, end))
    }
    return out
}
