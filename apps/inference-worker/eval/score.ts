/** Word error scoring for the transcription eval: normalized words, Levenshtein alignment. */

const NUMBERS: Record<string, string> = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten'
}
const SPELLING: Record<string, string> = {
  endeavor: 'endeavour', defense: 'defence', color: 'colour', honor: 'honour', favor: 'favour', labor: 'labour', gray: 'grey', mr: 'mister', mrs: 'missus', ok: 'okay'
}

/** Lowercase words without punctuation; apostrophes kept, hyphens split, a few spellings folded. */
export function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[-–—]/g, ' ')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
    .map((w) => NUMBERS[w] ?? SPELLING[w] ?? w)
}

export interface Alignment {
  refWords: number
  hypWords: number
  substitutions: number
  deletions: number
  insertions: number
  errors: number
  /** The inserted words themselves: words in the answer nobody said. */
  inserted: string[]
}

/**
 * `loose` (a clip cut mid-utterance, or a very short one): the reference is approximate at the
 * end, so words the answer has after the reference ends are neither inserted nor errors, and the
 * last reference word may be missing.
 */
export function align(refText: string, hypText: string, loose = false): Alignment {
  const ref = normalize(refText)
  let hyp = normalize(hypText)
  const n = ref.length
  // d[i][j]: cost of ref[0..i) against hyp[0..j)
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(hyp.length + 1).fill(0))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= hyp.length; j++) d[0][j] = j
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= hyp.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1))
  let endJ = hyp.length
  if (loose && n > 0) {
    // Best place for the reference to end in the answer; what follows is the cut's overhang.
    for (let j = 0; j <= hyp.length; j++) if (d[n][j] < d[n][endJ] || (d[n][j] === d[n][endJ] && j > endJ)) endJ = j
    hyp = hyp.slice(0, endJ)
  }
  let i = n, j = endJ
  let s = 0, del = 0
  const ins: string[] = []
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) s++
      i--, j--
    } else if (j > 0 && d[i][j] === d[i][j - 1] + 1) {
      ins.push(hyp[j - 1])
      j--
    } else {
      del++
      i--
    }
  }
  if (loose && del > 0) del-- // the cut's last word
  return { refWords: n, hypWords: hyp.length, substitutions: s, deletions: del, insertions: ins.length, errors: s + del + ins.length, inserted: ins.reverse() }
}
