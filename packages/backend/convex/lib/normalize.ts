/** Canonical key for de-duplicating user text (dictionary words, snippet triggers, app rules). */
export function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Trims, drops empties and case-insensitive duplicates, and never lets an alias equal the word. */
export function cleanAliases(word: string, aliases: readonly string[] | undefined): string[] {
  const wordKey = normalizeKey(word)
  const seen = new Set<string>()
  const out: string[] = []
  for (const alias of aliases ?? []) {
    const trimmed = alias.trim()
    const key = normalizeKey(trimmed)
    if (!key || key === wordKey || seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

export function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} must not be empty`)
  return trimmed
}

export function requireMaxLength(value: string, max: number, field: string): string {
  if (value.length > max) throw new Error(`${field} must be at most ${max} characters`)
  return value
}
