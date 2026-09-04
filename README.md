# Murmur

Hold a key, speak, and clean text lands wherever your cursor is. Murmur is a Wispr Flow–style
voice dictation app for **Windows** (top priority) and **Linux**, built with Electron. It brings
your own speech model — OpenAI Whisper, Groq, Deepgram, ElevenLabs, or a local whisper server — and
turns raw speech into polished, punctuated, formatted text that types itself into any application.

![Murmur home](docs/home.png)

## What it does

- **One key, two behaviours, at the same time**
  - **Hold to talk** — hold the shortcut, speak, release. The transcript is cleaned and inserted.
  - **Hands-free** — a quick *tap* (or *double-tap*, your choice, exactly like Wispr Flow) locks a
    session so you can keep your hands off the keyboard; tap again to stop and insert.
- **Bring your own models.** Any OpenAI-compatible `/v1/audio/transcriptions` endpoint works, plus
  native Deepgram and ElevenLabs. One-click **model discovery**, a **fallback model**, and a
  built-in **latency test** that transcribes a sample clip so you see real numbers before relying
  on it.
- **Wispr Flow–style cleanup.** Filler removal (um, uh, like…), stutter collapsing, self-corrections
  (“Tuesday, no, Wednesday” → “Wednesday”), spoken commands (“new line”, “new paragraph”,
  “scratch that”, “question mark”, “press enter”), a personal **dictionary** (used both as a
  recognition hint and as deterministic spelling correction), and voice **snippets**.
- **Optional smart formatting.** A small, fast LLM pass fixes punctuation, lists, numbers, and tone
  per app (casual in chat, professional in email). It always falls back to the instant rule-based
  result if the model is slow or misbehaves — a guard rejects answers/commentary so the model can
  never “reply” to your dictation.
- **Command mode.** Highlight text anywhere, hold a key, and say “make this more concise”,
  “translate to Spanish”, “turn this into bullet points”; the selection is rewritten in place.
- **A clean, minimal overlay.** A floating pill shows listening (live waveform), processing,
  success, and errors, plus a tray icon and a full settings/history UI.
- **Engineered for low latency.** Warm microphone, a rolling pre-roll buffer so the first word is
  never clipped, silence trimming, a no-speech skip that avoids a pointless network round-trip, and
  a per-stage latency breakdown for every dictation.
- **Local-first.** History, dictionary, and snippets live only on your device. API keys are stored
  with the OS keychain via Electron `safeStorage`.

## Quick start

```bash
npm install
npm run dev
```

On first launch an onboarding flow walks you through connecting a speech model, checking your
microphone, and choosing a shortcut. To try it immediately against a test endpoint you can seed the
provider from the environment:

```bash
MURMUR_BASE_URL=https://your-host/v1 \
MURMUR_API_KEY=sk-... \
MURMUR_STT_MODEL=whisper-large-v3-turbo \
MURMUR_LLM_MODEL=llama-3.1-8b-instant \
npm run dev
```

Default shortcuts:

| Action | Windows | Linux |
| --- | --- | --- |
| Hold / tap to dictate | `Ctrl + Win` | `Ctrl + Super` |
| Dedicated hands-free | `Ctrl + Win + Space` | `Ctrl + Super + Space` |
| Command mode (edit selection) | `Alt + Win` | `Alt + Super` |
| Cancel while listening | `Esc` | `Esc` |

All shortcuts are re-recordable in **Settings → Shortcuts**.

## Providers

Presets are included for OpenAI, Groq, Mistral (Voxtral), Deepgram, ElevenLabs Scribe, and local
servers (whisper.cpp `server`, Speaches / faster-whisper-server, LM Studio / LocalAI / vLLM). Any
other OpenAI-compatible proxy works via the **Custom** preset — set the base URL, key, and model.

- Speech-to-text uses `POST {baseUrl}/audio/transcriptions` (Whisper `verbose_json`, degrading to
  `json` automatically for servers that don't support it).
- Smart formatting and command mode use `POST {baseUrl}/chat/completions`.
- Model lists come from `GET {baseUrl}/models`, with speech models ranked first.

## How it works

```
key press ─▶ warm mic + pre-roll ─▶ VAD trim / no-speech skip ─▶ STT provider
   ▲                                                                   │
   └───────────────  overlay pill (listening / processing)            ▼
                                            rule-based cleanup ─▶ optional LLM formatting ─▶ guard
                                                                                              │
   focused app  ◀── paste (clipboard, restored) / type / clipboard-only ◀── final text ◀─────┘
```

- `src/core` — platform-agnostic, fully unit-tested logic: the hotkey state machine, audio
  (WAV/VAD/resample), the text pipeline (dictionary, fillers, commands, corrections, snippets,
  formatting), and the STT/LLM clients. No Electron imports, so it runs under Vitest directly.
- `src/main` — Electron main process: global key hook, text injection, windows, tray, stores,
  and the dictation orchestrator.
- `src/renderer` — the overlay (which also owns microphone capture via an `AudioWorklet`) and the
  React settings/history UI (Tailwind v4 + Radix primitives).
- `src/preload` — the typed, context-isolated bridges.

### Text injection

| Platform | Primary | Notes |
| --- | --- | --- |
| Windows | Win32 `SendInput` via [koffi](https://koffi.dev) | Unicode paste-through-clipboard or direct typing; no compiler needed. |
| Linux (X11) | `xdotool` | Paste + clipboard restore, or direct type. |
| Linux (Wayland) | `wtype` / `ydotool` | Install one of them; XWayland apps also work via `xdotool`. |

The default strategy pastes through the clipboard and restores your previous clipboard afterwards.
If the low-level keyboard hook can't start (e.g. a locked-down Wayland session), Murmur falls back
to Electron's `globalShortcut`, where the shortcut toggles hands-free instead of holding.

## Testing

```bash
npm test          # unit tests for the whole core (hotkey, audio, text, providers, settings)
npm run test:live # live integration test against a real endpoint (see below)
```

The live suite is opt-in and hits a real provider using a bundled speech fixture
(`resources/fixtures/jfk.wav`):

```bash
MURMUR_LIVE=1 \
MURMUR_BASE_URL=https://your-host/v1 \
MURMUR_API_KEY=sk-... \
MURMUR_STT_MODEL=whisper-large-v3-turbo \
MURMUR_LLM_MODEL=llama-3.1-8b-instant \
npm run test:live
```

## Building installers

```bash
npm run build:win     # NSIS installer + portable .exe (x64, arm64)
npm run build:linux   # AppImage + .deb (x64, arm64)
```

Native modules (`uiohook-napi`, `koffi`) ship as prebuilt binaries and are unpacked from the asar
automatically, so there is no native compile step.

## Requirements

- Node.js 22+
- Windows 10/11, or Linux with X11 (`xdotool`) or Wayland (`wtype`/`ydotool`)
- macOS is not a priority yet; the code paths exist but are untested.

## License

MIT
