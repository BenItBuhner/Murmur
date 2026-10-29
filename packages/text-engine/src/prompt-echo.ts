/**
 * Whisper-family models read the prompt as the transcript of the audio before the clip. Given a
 * clip with no speech in it (background noise, a phone being handled, the tap that stops a
 * dictation), they can answer with the prompt itself: Oct 29 2026, a noise-only release tail came
 * back as "Dictation with punctuation." and was typed after the dictation. Reproduced on the
 * production models: 2 s of -40 dB noise with "Vocabulary: …. Dictation with punctuation." as the
 * prompt answers exactly that, every time; real speech, even quiet, never does.
 *
 * A sentence that is nothing but a run of the prompt's own words, and that cannot be the speaker
 * (it holds the style hint's "punctuation" or opens with "Vocabulary"), is dropped. Ordinary
 * sentences that merely mention a vocabulary term are kept. Mirrored in
 * apps/android/.../text/PromptEcho.kt.
 */

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu
const SENTENCE = /[^.!?…]*[.!?…]+["')\]]*\s*|[^.!?…]+$/gu

function wordsOf(s: string): string[] {
  return (s.match(WORD) ?? []).map((w) => w.toLowerCase().replace(/’/g, "'"))
}

/** Does `run` appear in `words` as consecutive words? */
function isRunOf(words: readonly string[], run: readonly string[]): boolean {
  if (!run.length || run.length > words.length) return false
  outer: for (let i = 0; i + run.length <= words.length; i++) {
    for (let j = 0; j < run.length; j++) if (words[i + j] !== run[j]) continue outer
    return true
  }
  return false
}

/** One sentence of a transcript is the prompt read back. */
export function isPromptEcho(sentence: string, prompt: string | null | undefined): boolean {
  if (!prompt) return false
  const s = wordsOf(sentence)
  if (s.length < 2) return false
  if (!s.includes('punctuation') && s[0] !== 'vocabulary') return false
  return isRunOf(wordsOf(prompt), s)
}

/**
 * The transcript without sentences that are the prompt read back, and without a lone mark the
 * model gives for silence ("."). Unchanged (same string) when there is nothing to drop.
 */
export function stripPromptEcho(text: string, prompt: string | null | undefined): string {
  if (!text) return text
  if (!/[\p{L}\p{N}]/u.test(text)) return text.trim() ? '' : text
  if (!prompt) return text
  const sentences = text.match(SENTENCE) ?? [text]
  const keep = sentences.filter((s) => !isPromptEcho(s, prompt))
  if (keep.length === sentences.length) return text
  return keep.join('').trim()
}
