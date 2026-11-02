# Murmur: brand and website design system (proposal)

Status: proposal only, open for Bennett's review. Nothing here is merged or deployed.

## Identity

**Idea.** Speech turning into text: a soft voice that lands exactly where you meant it.

**Mark (redrawn Nov 2, 2026).** Four rising voice bars that end in a text caret: what you say becomes the text at
your cursor. White on the voice gradient (coral `#FF8A6B` into violet `#8B5CFF` into indigo `#5B3DF5`); the bars sit
a little quieter than the caret. It replaces the earlier soft lowercase m. The geometry is in
`src/components/wordmark.tsx` (`Mark`) and `src/app/icon.svg`; keep them identical.

- Minimum size 16 px. Clear space: a quarter of the tile on every side.
- The tile always carries the gradient; don't flatten it to one colour or put the mark on a photo.

**Wordmark.** The mark, then "Murmur" in Inter Tight SemiBold at 21 px, tracking -0.035em.

**Voice.** Quiet, exact and checkable. Say what happens to your words and where they go; point to the source when a
claim can be checked. No "magic", no "10x".

| Do | Don't |
|---|---|
| "Recordings never leave the device." | "Military-grade privacy" |
| "Hold a key. Speak. The words land where your cursor is." | "The future of typing is here!" |

## Type (site)

Second pass (Nov 2026): the condensed serif headlines read as an editorial blog and looked cramped, so headlines
move to a clean sans and the serif becomes a single accent.

| Role | Face | Size / weight |
|---|---|---|
| Hero | Inter Tight | 44 / 64 / 80 px by breakpoint, 600, -0.03em, line height 1.02 |
| Section title | Inter Tight | 36 px mobile, 44 px desktop, 600, -0.03em |
| Card title | Inter Tight | 27 px, 600 |
| Accent word | Instrument Serif italic | one word per headline, 1.06-1.08em, on the voice gradient |
| Body | Inter | 16 px; lead 18 px; notes 14.5 px with 1.65 line height |
| Eyebrow | Inter | 12 px, 600, 0.12em tracking, uppercase, brand ink (violet on night) |

Instrument Serif stays the apps' display face; on the site it only carries the accent word.

## Page rhythm

The page alternates two grounds so it never reads as one long beige column:

- **Night** (`--night`, `oklch(0.145 0.02 285)`): header, hero stage, the engine, the closing band, the footer.
- **Canvas** (`--background`, a cool near-white): steps, destinations, models, platforms, principles.

The hero is a stage: headline centred, then the product at work. A compose window shows the text Murmur typed, the
dictation pill floats at its bottom edge as on a real desktop, and two night-glass notes show the raw transcript
(removed words struck through in coral) and the verifier's checks for the same pair.

Cards are white with a 1 px hairline plus a soft shadow (`--elevation-raised`); nested panels are tinted, never
grey boxes. Step and principle cards carry a visual or an icon, not only text.

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
- `hero-glow`, `hero-grid`, `cta-glow`: the violet bloom with a coral ember and a faint dot grid on the night bands.
- `stage-frame`, `stage-card`: the product window and the night-glass notes beside it.
- `spoken-cut`: words the engine removed, struck through in coral.
- `voice-wave` is no longer used on the home page.
- `night-band`: the final call to action as a dark violet band, in both colour schemes.
- `Button` variants: `light` (white pill on night: Download in the header, hero and closing band), `night-ghost`
  (outlined on night), `brand` (brand ink on the canvas, for the account call to action). Every other button keeps
  the app variants.

All motion stops under `prefers-reduced-motion`.

## Accessibility fixes made on the way

axe-core flagged three issues on the home page. They predate this proposal and are fixed here:

- The engine step numerals were at 2.5:1. They now use `--brand-violet`.
- The "Caught:" label used the record colour on a light well. It now uses a darker coral in light mode.
- The transcript demo's `<dl>` wrapped `dt`/`dd` in an extra `div`. The status dot now sits inside the `dt`.

axe-core (WCAG 2 A and AA) is now clean on `/`, `/download`, `/pricing` and `/account`.

Second pass: axe-core is clean on `/`, `/download` and `/account` (`/pricing` is off while billing is off).
