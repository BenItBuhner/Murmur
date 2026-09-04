# Murmur

Hold a key (or tap a pill), speak, and clean text lands wherever your cursor is. Murmur is a
Wispr Flow–style voice dictation tool. It brings your own speech model — OpenAI Whisper, Groq,
Deepgram, ElevenLabs, or a local whisper server — and turns raw speech into polished, punctuated,
formatted text that types itself into any application.

This is a monorepo:

| App | Path | Platforms |
| --- | --- | --- |
| Desktop (Electron) | [`apps/desktop`](apps/desktop) | **Windows**, **Linux**, macOS (experimental) |
| Android | [`apps/android`](apps/android) | Android 8.0+ |

![Murmur home](docs/home.png)

## Desktop (`apps/desktop`)

- **One key, two behaviours, at the same time**
  - **Hold to talk** — hold the shortcut, speak, release. The transcript is cleaned and inserted.
  - **Hands-free** — a quick *tap* (or *double-tap*, your choice, exactly like Wispr Flow) locks a
    session so you can keep your hands off the keyboard; tap again to stop and insert.
- **Bring your own models.** Any OpenAI-compatible `/v1/audio/transcriptions` endpoint works, plus
  native Deepgram and ElevenLabs. One-click **model discovery**, a **fallback model**, and a
  built-in **latency test**.
- **Wispr Flow–style cleanup.** Filler removal, stutter collapsing, self-corrections
  (“Tuesday, no, Wednesday” → “Wednesday”), spoken commands (“new line”, “new paragraph”,
  “scratch that”, “question mark”, “press enter”), a personal **dictionary**, and voice **snippets**.
- **Optional smart formatting.** A small, fast LLM pass fixes punctuation, lists, numbers, and tone
  per app. It always falls back to the instant rule-based result — a guard rejects
  answers/commentary so the model can never “reply” to your dictation.
- **Command mode.** Highlight text anywhere, hold a key, and say “make this more concise”; the
  selection is rewritten in place.

### Quick start

```bash
cd apps/desktop
npm install
npm run dev
```

To try it immediately against a test endpoint you can seed the provider from the environment:

```bash
MURMUR_BASE_URL=https://your-host/v1 \
MURMUR_API_KEY=sk-... \
MURMUR_STT_MODEL=whisper-large-v3-turbo \
MURMUR_LLM_MODEL=llama-3.1-8b-instant \
npm run dev
```

Default shortcuts (re-recordable in **Settings → Shortcuts**):

| Action | Windows | Linux / macOS |
| --- | --- | --- |
| Hold / tap to dictate | `Ctrl + Win` | `Ctrl + Super` / `Ctrl + Cmd` |
| Dedicated hands-free | `Ctrl + Win + Space` | `Ctrl + Super + Space` |
| Command mode (edit selection) | `Alt + Win` | `Alt + Super` |
| Cancel while listening | `Esc` | `Esc` |

### Text injection

| Platform | Primary | Notes |
| --- | --- | --- |
| Windows | Win32 `SendInput` via [koffi](https://koffi.dev) | Unicode paste-through-clipboard or direct typing; no compiler needed. |
| Linux (X11) | `xdotool` | Paste + clipboard restore, or direct type. |
| Linux (Wayland) | `wtype` / `ydotool` | Install one of them; XWayland apps also work via `xdotool`. |
| macOS | AppleScript / System Events | Requires the Accessibility permission. **Experimental: implemented but not yet tested on real hardware.** |

### Test & build

```bash
cd apps/desktop
npm test              # unit tests for the whole core
npm run test:live     # opt-in live test against a real endpoint (MURMUR_LIVE=1 + env above)
npm run build:win     # NSIS installer + portable .exe (x64, arm64)
npm run build:linux   # AppImage + .deb (x64, arm64)
npm run build:mac     # dmg + zip (x64, arm64) — experimental
```

## Android (`apps/android`)

The exact same Wispr Flow pattern on your phone: whenever the keyboard opens, a floating
**dictation pill** pops up right above it. Tap the pill, speak, tap the check — the transcript
runs through the same providers and the same cleanup pipeline (fillers, spoken commands,
self-corrections, LLM smart formatting with the same prompt and guard rails), and the text is
inserted into the focused field of *any* app.

- **Overlay pill** — hosted by an accessibility service (`TYPE_ACCESSIBILITY_OVERLAY`), shown
  when the on-screen keyboard is visible, positioned just above it. X cancels, ✓ stops and inserts.
- **Text injection** — accessibility `ACTION_SET_TEXT` at the cursor position (with selection
  handling), falling back to clipboard + `ACTION_PASTE` for fields that block direct writes.
  “Press enter” dictation triggers `ACTION_IME_ENTER`.
- **Same models** — the OpenAI-compatible, Deepgram, and ElevenLabs clients are Kotlin ports of
  the desktop core, including model discovery, the fallback-model retry, and the
  `verbose_json` → `json` downgrade.
- **Recording** — 16 kHz mono PCM via `AudioRecord` inside a microphone foreground service.
- **App-aware tone** — chat apps get casual, email gets professional, terminals get no trailing
  punctuation, keyed off the focused app’s package name.

### Build & run

```bash
cd apps/android
./gradlew :app:assembleDebug          # requires ANDROID_HOME + JDK 17+
./gradlew :app:testDebugUnitTest      # JVM unit tests (pipeline, prompt guard)
adb install app/build/outputs/apk/debug/app-debug.apk
```

Provider defaults can be baked into a build from the environment (same variables as desktop):
`MURMUR_BASE_URL`, `MURMUR_API_KEY`, `MURMUR_STT_MODEL`, `MURMUR_LLM_MODEL`. Everything is also
configurable at runtime in the app.

In-app setup: grant **Microphone**, **Display over other apps**, and enable the **Murmur
dictation accessibility service**. The Settings screen has model discovery, a live sample-clip
test against your endpoint, and a test pad. For emulators without a microphone there is a
“use sample clip” mode that dictates a bundled fixture through the real provider pipeline.

The live endpoint test mirrors the desktop one:

```bash
cd apps/android
MURMUR_LIVE=1 MURMUR_BASE_URL=https://your-host/v1 MURMUR_API_KEY=sk-... \
MURMUR_STT_MODEL=whisper-large-v3-turbo MURMUR_LLM_MODEL=llama-3.1-8b-instant \
./gradlew :app:testDebugUnitTest --tests '*LiveEndpointTest*'
```

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
trigger (hotkey / pill tap) ─▶ mic capture ─▶ no-speech skip ─▶ STT provider
   ▲                                                                 │
   └──────────── overlay pill (listening / processing)              ▼
                                        rule-based cleanup ─▶ optional LLM formatting ─▶ guard
                                                                                          │
   focused app/field  ◀── paste / type / set-text ◀── final text ◀─────────────────────────┘
```

- `apps/desktop/src/core` — platform-agnostic, fully unit-tested logic: the hotkey state machine,
  audio (WAV/VAD/resample), the text pipeline, and the STT/LLM clients.
- `apps/desktop/src/main` — Electron main process: global key hook, text injection, windows, tray.
- `apps/desktop/src/renderer` — the overlay and the React settings/history UI.
- `apps/android/app/src/main/java/app/murmur/android` — Kotlin ports of the same core
  (`text/`, `stt/`, `llm/`), plus the accessibility service, overlay pill, and Compose settings UI.

## Requirements

- **Desktop:** Node.js 22+; Windows 10/11, Linux with X11 (`xdotool`) or Wayland (`wtype`/`ydotool`),
  or macOS 12+ (experimental).
- **Android:** Android Studio or plain Gradle with JDK 17+, `ANDROID_HOME` pointing at an SDK with
  platform 35. Runs on Android 8.0 (API 26) and later.

## License

MIT
