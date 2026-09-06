/**
 * Per-user caps. They keep every per-user query bounded (so `collect()` on a user index stays cheap)
 * and stop a misbehaving client from filling the database.
 */
export const LIMITS = {
  dictionaryEntries: 5000,
  snippets: 1000,
  appRules: 500,
  devices: 50,
  /** Oldest entries beyond this are pruned on push. */
  historyEntries: 5000,
  /** Largest batch a single import/push mutation accepts. */
  batch: 500,
  wordLength: 120,
  aliasLength: 120,
  aliasesPerEntry: 20,
  snippetTriggerLength: 120,
  snippetContentLength: 20_000,
  appRuleMatchLength: 200,
  fillerWords: 100,
  hesitationPhrases: 100,
  /** Free-form model instructions (global or per app rule). */
  instructionsLength: 2000,
  historyTextLength: 20_000,
  deviceNameLength: 120
} as const
