# Real speech through the dictation pipeline

Spoken dictations, synthesized locally, go through the real `DictationController` (chunking,
tail speculation, release, seams, endings) with every speech request answered by a local Whisper
large-v3-turbo. Nothing leaves the machine; no CI.

```sh
pip install sherpa-onnx==1.12.40 soundfile numpy   # 2.x has no espeak front end for Piper voices
# models (GitHub releases of k2-fsa/sherpa-onnx) into $MURMUR_MODELS:
#   asr-models/sherpa-onnx-whisper-turbo
#   tts-models/vits-piper-en_US-amy-medium, -en_GB-alan-medium, -en_US-ryan-medium, -en_US-libritts_r-medium
MURMUR_MODELS=/path/to/models python3 tts.py /tmp/rs/audio     # 14 dictations + meta.json
MURMUR_MODELS=/path/to/models python3 server.py &              # POST a WAV to :8765, get {text}
cd ../../.. && MURMUR_REAL_SPEECH=/tmp/rs/audio MURMUR_REAL_SPEECH_TAG=mine \
  npx vitest run tests/bench/real-speech.test.ts               # writes /tmp/rs/audio/result-mine.json
```

The set: the five `packages/text-engine/eval/long` samples, three of them again ending on a spoken
"Thank you.", and six short ones; four voices (one with 900 speakers), mid-sentence hesitations of
0.7-1.6 s, room noise, and endings of quiet, long quiet, a breath, a click or a rustle. Each result
row has word error, sentence breaks/caps against what was said, words lost at the end, and words
added after the last spoken one.
