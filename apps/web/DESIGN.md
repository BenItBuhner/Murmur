# Murmur: brand and website design system (proposal)

Status: proposal only, open for Bennett's review. Nothing here is merged or deployed.

## Identity

**Idea.** Speech turning into text: a soft voice that lands exactly where you meant it.

**Mark.** A lowercase m drawn as two soft arches, with a quieter third bar for the voice trailing off, in white on
the voice gradient (coral `#FF8A6B` into violet `#8B5CFF` into indigo `#5B3DF5`). The geometry is in
`src/components/wordmark.tsx` (`Mark`) and `src/app/icon.svg`; keep them identical.

- Minimum size 16 px. Clear space: a quarter of the tile on every side.
- The tile always carries the gradient; don't flatten it to one colour or put the m on a photo.

**Wordmark.** The mark, then "Murmur" in Instrument Serif at 27 px, tracking -0.02em, as the apps set the name.

**Voice.** Quiet, exact and checkable. Say what happens to your words and where they go; point to the source when a
claim can be checked. No "magic", no "10x".

| Do | Don't |
|---|---|
| "Recordings never leave the device." | "Military-grade privacy" |
| "Hold a key. Speak. The words land where your cursor is." | "The future of typing is here!" |

## Type (site)

The site now reads larger than the apps, because a page is read at arm's length and an app panel is glanced at:
caption 12, meta 13, note 14.5, body 16, lead 18 px (sans, Inter); heading 27, numeral 34, title 44, display 60,
hero 80 px (Instrument Serif). Muted text is darker (`oklch(0.45 0.012 60)` in light mode). Eyebrows are 600 weight
in brand ink (brand violet in dark mode).

## Brand layer

The site shares its tokens with the desktop and Android apps (see the header of `src/app/globals.css`). The brand layer (Aurora) leaves the colours alone, raises the type scale for the site and adds a thin brand layer for the website only. The idea is a voice glow from violet into the record coral, so the page feels like speech turning into text.

## Brand tokens (site only)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--brand-violet` | `oklch(0.56 0.2 295)` | `oklch(0.7 0.17 295)` | gradient start, step numerals |
| `--brand-coral` | `oklch(0.68 0.19 35)` | same | gradient end (the record colour) |
| `--brand-ink` | `oklch(0.36 0.15 290)` | `oklch(0.5 0.17 290)` | the brand button (white text) |
| `--brand-glow` | violet at 30% | violet at 30% | the aurora behind the hero demo |
| `--night` / `-foreground` / `-muted` | `oklch(0.17 0.02 290)` and light text | same | the closing call to action |
| `--text-hero` | 76px / 0.98 | | hero headline at `xl` |

## Pieces

- `brand-text`: one italic word per headline in the violet-to-coral gradient. It is only used on display sizes, where 3:1 applies.
- `aurora`: two blurred, slowly drifting glows behind the hero's transcript demo and in the closing band.
- `voice-wave` (`components/landing/voice-wave.tsx`): a spoken line drawn across the bottom of the hero and through the closing band. It is two copies of one path, so the drift loops without a seam.
- `night-band`: the final call to action as a dark violet band, in both colour schemes.
- `Button` variant `brand`: brand ink with a soft violet glow. It is used for Download in the header, the hero and the closing band. Every other button keeps the app variants.

All motion stops under `prefers-reduced-motion`.

## Accessibility fixes made on the way

axe-core flagged three issues on the home page. They predate this proposal and are fixed here:

- The engine step numerals were at 2.5:1. They now use `--brand-violet`.
- The "Caught:" label used the record colour on a light well. It now uses a darker coral in light mode.
- The transcript demo's `<dl>` wrapped `dt`/`dd` in an extra `div`. The status dot now sits inside the `dt`.

axe-core (WCAG 2 A and AA) is now clean on `/`, `/download`, `/pricing` and `/account`.
