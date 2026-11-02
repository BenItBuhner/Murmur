import { countWords } from './text'
import type { ChatMessage } from './types'

/**
 * Grammar-correction prompt from Bennett's AutoHotkey script
 * (BenItBuhner/Insta-AI-Correct, Auto-Correct Hotkey.ahk). Kept verbatim so Murmur
 * does not invent a second correction language.
 */
export const AUTOCORRECT_SYSTEM_PROMPT =
  'You are a grammar correction and alignment agent. Your sole and only goal here is to fix any and all grammatical errors with minimal augmentation to the original text or meaning, including spelling, styling, and punctuation. Correct the text while keeping it as original as feasibly possible, not altering correct words or phrases in any way. Return only the final corrected text in your response; do not add any preamble, explanation, or other text.'

/**
 * First `{instructions}` block in the text, the same way the AHK script's
 * `RegExMatch(..., "s)\{(.*?)\}")` does: the inside becomes the system prompt and
 * that brace block is removed from the user text. No match keeps the script's default.
 */
const EMBEDDED_INSTRUCTIONS = /\{(.*?)\}/s

export interface AutocorrectRequest {
  systemPrompt: string
  userText: string
}

export function splitAutocorrectInput(text: string): AutocorrectRequest {
  const match = EMBEDDED_INSTRUCTIONS.exec(text)
  if (!match) return { systemPrompt: AUTOCORRECT_SYSTEM_PROMPT, userText: text }
  return {
    systemPrompt: match[1] ?? AUTOCORRECT_SYSTEM_PROMPT,
    userText: text.replaceAll(match[0], '')
  }
}

/** Chat messages for one correction: system prompt, then the text to alter. */
export function buildAutocorrectMessages(text: string): ChatMessage[] {
  const { systemPrompt, userText } = splitAutocorrectInput(text)
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText }
  ]
}

/** Room for the whole selection again, plus a margin (same bound command mode uses). */
export function autocorrectMaxTokens(text: string): number {
  return Math.min(4096, Math.max(1024, countWords(text) * 4 + 512))
}

/** Temperature the AHK script sent with every Groq request. */
export const AUTOCORRECT_TEMPERATURE = 0.2
