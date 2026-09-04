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

## Android (`apps/android`)

The same Wispr Flow pattern on your phone: a floating dictation pill above the keyboard.

```bash
cd apps/android
./gradlew :app:assembleDebug
```

## License

MIT
