# Transcription animation concepts (prototypes)

Five live-transcription animations for the dictation pill, each played against the **real**
current pill (`src/renderer/src/overlay/Overlay.tsx`, imported unchanged) with one shared script:
the same words at the same times, the same voice level and the same phase changes
(`src/script.ts`: idle, 8s listening, 1.2s processing, 1.4s inserted).

Prototype only: nothing here is wired into the app, built, or shipped.

| Concept         | Idea                                                                                                                                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inkline`       | The pill is a live caption. Words condense out of a blur as they are heard; on stop a light sweeps across and rewrites the raw words into the cleaned sentence.                                                                                                                     |
| `aurora`        | **Tone-aware.** The pill is lit from inside by the mood of the clause being said (calm slate, frustrated ember, excited gold, asking violet). Words are re-inked when their clause is understood; the light swells with the voice; the insert shows the take's mood as a tiny band. |
| `loom`          | The waveform is the type: letters are spun out of a head of live bars, each glyph starting as a tall stroke and relaxing into its letterform. On stop every letter flips, in a wave, from heard to clean.                                                                           |
| `constellation` | Each sound leaves a star (brighter and further off the line when louder); a word's stars are threaded together once it is recognised. On stop they gather into a turning ring, then settle into the check.                                                                          |
| `chips`         | **Content-aware.** Topics, blockers, questions and dates lift out of the words that carried them as chips over the pill, then drop back in; the insert offers the date as a reminder.                                                                                               |

Tone and entities come from a small lexicon in `script.ts`, a stand-in for the model. In the
real thing they would come from the streaming transcript classified clause by clause (a small
on-device classifier or the formatting model's structured output), which is why tones arrive at
clause granularity and can recolour words already on screen.

## Run

```sh
cd apps/desktop
npx vite --config prototypes/transcription-animations/vite.config.ts
# http://localhost:5199/?c=baseline|inkline|aurora|loom|constellation|chips  (loops)
node prototypes/transcription-animations/scripts/record.cjs /tmp/out   # one take each, as mp4
```
