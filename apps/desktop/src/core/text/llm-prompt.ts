import type { DictionaryEntry } from '@shared/settings'
import { languageName } from '@shared/languages'
import type { ChatMessage } from '@core/llm/client'
import { categoryHint, toneDescription, type AppContext, type ResolvedStyle } from './app-context'
import { countWords } from './util'

export interface FormatPromptInput {
  raw: string
  dictionary: readonly DictionaryEntry[]
  style: ResolvedStyle
  app: AppContext
  /**
   * Dictation language as stored in settings: 'auto' or an ISO-639-1 code. With a fixed language
   * the model is told to write in it and to treat stray words in another language as recognition
   * errors, which is what stops a mumbled phrase from coming back in the wrong language.
   */
  language?: string
  /** Text immediately before the cursor, when known (e.g. from command-mode selection). */
  precedingText?: string
}

/**
 * The rules about language, shared by the format prompt on desktop and Android. Auto-detect keeps
 * the classic "preserve the language" rule; a fixed language pins the output to it.
 */
export function languageRules(language: string | undefined): string[] {
  const name = languageName(language)
  if (!name) {
    return [
      "- Preserve the speaker's words, meaning, order, and language. Write the output in the language the speaker used. Never summarize, expand, answer, translate, or add anything they did not say."
    ]
  }
  return [
    `- The speaker dictates in ${name}. Write the output in ${name} and never translate it into another language.`,
    `- The recognizer sometimes renders unclear speech as words from another language. Treat such stray fragments as recognition errors and write what the speaker most plausibly said in ${name}; keep foreign names and terms the speaker clearly used on purpose.`,
    "- Preserve the speaker's words, meaning, and order. Never summarize, expand, answer, or add anything they did not say."
  ]
}

export function buildFormatMessages(input: FormatPromptInput): ChatMessage[] {
  const terms = input.dictionary
    .map((d) => d.word.trim())
    .filter(Boolean)
    .slice(0, 80)
  const lines = [
    'You are the cleanup stage inside a voice dictation tool. The user spoke the text below and a speech recognizer transcribed it. Rewrite it as the polished text they intended to type.',
    '',
    'Rules:',
    ...languageRules(input.language),
    '- Fix punctuation, capitalization, and obvious transcription errors.',
    '- Remove filler sounds (um, uh, er, hmm) and verbal tics used as filler (like, you know, sort of, I mean); collapse stutters and repeated words. Keep every word that carries meaning, including greetings and openers such as "hey", "so", "okay", "thanks".',
    '- Apply self-corrections: "Tuesday, no, Wednesday" becomes "Wednesday"; "scratch that" removes the phrase before it.',
    '- Format an enumeration ("first... second..." or "one... two...") as a list with "- " bullets or "1." numbering, one item per line. Otherwise keep the speaker\'s paragraphs.',
    '- Use digits for quantities, times, dates, money, and versions ("five pm" -> "5 pm", "version two point three" -> "version 2.3").',
    '- Spoken "new line" means a line break and "new paragraph" means a blank line.',
    terms.length ? `- Spell these terms exactly as written: ${terms.join(', ')}.` : '',
    `- Tone: ${toneDescription(input.style.tone)}`,
    `- The text is going into ${categoryHint(input.app.category)}${input.app.app ? ` (${input.app.app})` : ''}.`,
    '- Do not wrap the result in quotes or code fences. Do not add greetings, sign-offs, notes, or explanations. If the transcript is empty or only noise, output nothing.',
    '',
    'Output only the cleaned text.'
  ].filter((l) => l !== '')
  const messages: ChatMessage[] = [{ role: 'system', content: lines.join('\n') }]
  if (input.precedingText) {
    messages.push({
      role: 'user',
      content: `Text already before the cursor (context only, do not repeat it):\n${input.precedingText.slice(-600)}`
    })
    messages.push({ role: 'assistant', content: 'Understood. Send the transcript.' })
  }
  messages.push({ role: 'user', content: input.raw })
  return messages
}

export interface CommandPromptInput {
  selection: string
  instruction: string
  app: AppContext
  dictionary: readonly DictionaryEntry[]
  /** Dictation language ('auto' or an ISO-639-1 code): the language the instruction was spoken in. */
  language?: string
}

export function buildCommandMessages(input: CommandPromptInput): ChatMessage[] {
  const terms = input.dictionary
    .map((d) => d.word.trim())
    .filter(Boolean)
    .slice(0, 80)
  const spoken = languageName(input.language)
  const system = [
    'You are an in-place text editor driven by voice. The user highlighted some text and spoke an instruction. Apply the instruction to the text and return only the edited text.',
    spoken
      ? `- The user speaks ${spoken}, so the instruction is in ${spoken}. Keep the text in its original language unless the instruction asks to translate.`
      : '- Keep the original language unless asked to translate.',
    '- Preserve formatting (line breaks, lists, markdown) unless the instruction changes it.',
    '- Never add commentary, quotes, or code fences around the result.',
    terms.length ? `- Spell these terms exactly: ${terms.join(', ')}.` : '',
    `- The text lives in ${categoryHint(input.app.category)}.`
  ]
    .filter(Boolean)
    .join('\n')
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Instruction: ${input.instruction.trim()}\n\nText:\n${input.selection}`
    }
  ]
}

const CHATTY_PREFIX =
  /^(?:sure|certainly|of course|here(?:'s| is| are)|i(?:'m| am) sorry|as an ai|i can(?:'t|not)|the cleaned|cleaned text|here you go|i'd be happy)\b/i
const QUESTION_START =
  /^(?:what|who|whom|whose|when|where|why|how|which|is|are|was|were|do|does|did|can|could|will|would|should|shall|may|might)\b/i
const LABEL_PREFIX =
  /^(?:(?:here is |here's )?(?:the )?(?:cleaned(?: up)?|formatted|polished|final|corrected|edited)(?: text| version| transcript)?|output|result|text|transcript)\s*:\s*/i

export interface SanitizeResult {
  ok: boolean
  text: string
  reason?: string
}

/**
 * Guard rails for the model output. The failure mode we care about is the model treating the
 * dictation as a question and answering it, or wrapping the result in commentary. Anything
 * rejected here makes the caller fall back to the deterministic pipeline output.
 */
export function sanitizeLlmOutput(output: string, raw: string): SanitizeResult {
  let text = output.replace(/\r\n?/g, '\n').trim()
  text = text.replace(/^```[a-z]*\n?([\s\S]*?)\n?```$/i, '$1').trim()
  if (/^["“”'].*["“”']$/s.test(text) && !/^["“”']/.test(raw.trim())) text = text.slice(1, -1).trim()
  text = text.replace(LABEL_PREFIX, '').trim()

  if (!text) return { ok: false, text: '', reason: 'empty' }
  const rawTrim = raw.trim()
  if (CHATTY_PREFIX.test(text) && !CHATTY_PREFIX.test(rawTrim))
    return { ok: false, text, reason: 'chatty' }

  const rawWords = countWords(raw)
  const outWords = countWords(text)
  if (rawWords >= 6) {
    const ratio = outWords / rawWords
    if (ratio < 0.35) return { ok: false, text, reason: 'too-short' }
    if (ratio > 2.2) return { ok: false, text, reason: 'too-long' }
  } else if (outWords > rawWords + 6) {
    return { ok: false, text, reason: 'too-long' }
  }

  // A dictated question must still be a question; an answer is the classic failure.
  if (
    QUESTION_START.test(rawTrim) &&
    rawWords >= 3 &&
    !/\?/.test(text) &&
    !/\?/.test(rawTrim) === true
  ) {
    if (!QUESTION_START.test(text)) return { ok: false, text, reason: 'answered' }
  }

  // The rewrite must share most of its content words with the transcript.
  if (rawWords >= 5) {
    const rawSet = contentWords(raw)
    const outSet = contentWords(text)
    if (rawSet.size >= 3 && outSet.size > 0) {
      let shared = 0
      for (const w of outSet) if (rawSet.has(w)) shared++
      const overlap = shared / outSet.size
      if (overlap < 0.45) return { ok: false, text, reason: 'diverged' }
    }
  }
  return { ok: true, text }
}

function contentWords(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) {
    if (w.length >= 3) out.add(w.replace(/^'+|'+$/g, ''))
  }
  return out
}

/**
 * Upper bound for completion tokens. Reasoning models spend hidden tokens before answering, so
 * this is a runaway guard rather than a budget: a tight cap returns an empty message.
 */
export function maxTokensFor(raw: string, multiplier = 2): number {
  const words = countWords(raw)
  return Math.min(4096, Math.max(768, Math.ceil(words * 1.6 * multiplier) + 512))
}
