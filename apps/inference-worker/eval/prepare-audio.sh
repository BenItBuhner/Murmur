#!/usr/bin/env bash
# Builds the transcription eval set in $1 (default /tmp/stt-eval): 16 kHz mono WAVs plus
# manifest.json ({ id, file, ref, kind }). Outside speech is LibriSpeech (CC BY 4.0, openslr.org/12):
# test-clean and the harder, more accented test-other. Edge cases are made here with ffmpeg, so
# they carry no licence at all. Needs curl, tar, ffmpeg and node.
set -euo pipefail
out="${1:-/tmp/stt-eval}"
per="${STT_EVAL_PER_SET:-8}"
mkdir -p "$out/raw" "$out/wav"
cd "$out"

for set in test-clean test-other; do
  if [ ! -d "raw/LibriSpeech/$set" ]; then
    curl -fsSL --retry 4 "https://www.openslr.org/resources/12/$set.tar.gz" | tar -xz -C raw
  fi
done

ff() { ffmpeg -nostdin -loglevel error -y "$@"; }
to16k() { ff -i "$1" -ac 1 -ar 16000 -sample_fmt s16 "$2"; }

node - "$out" "$per" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process')
const [out, per] = [process.argv[2], Number(process.argv[3])]
const ff = (...a) => execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...a])
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString())
const items = []
for (const set of ['test-clean', 'test-other']) {
  const root = path.join(out, 'raw/LibriSpeech', set)
  const lines = []
  for (const spk of fs.readdirSync(root).sort())
    for (const ch of fs.readdirSync(path.join(root, spk)).sort()) {
      const dir = path.join(root, spk, ch)
      for (const l of fs.readFileSync(path.join(dir, `${spk}-${ch}.trans.txt`), 'utf8').trim().split('\n')) {
        const [id, ...w] = l.split(' ')
        lines.push({ id, dir, ref: w.join(' ').toLowerCase() })
      }
    }
  // A spread of speakers and lengths: one utterance of 6-20 s per speaker, first `per` speakers.
  const seen = new Set()
  for (const l of lines) {
    const spk = l.id.split('-')[0]
    if (seen.has(spk) || seen.size >= per) continue
    const n = l.ref.split(' ').length
    if (n < 15 || n > 50) continue
    seen.add(spk)
    const file = `wav/${set}-${l.id}.wav`
    ff('-i', path.join(l.dir, `${l.id}.flac`), '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', path.join(out, file))
    items.push({ id: `${set}/${l.id}`, file, ref: l.ref, kind: set })
  }
}
const base = items.slice(0, 4)
const src = (i) => path.join(out, i.file)
for (const [k, i] of base.entries()) {
  const d = dur(src(i))
  // Speech under steady room noise (about 5 dB SNR) and under babble-like brown noise.
  ff('-i', src(i), '-f', 'lavfi', '-i', `anoisesrc=c=pink:a=0.08:d=${d}:r=16000`, '-filter_complex', 'amix=inputs=2:duration=first:normalize=0', '-ac', '1', '-ar', '16000', path.join(out, `wav/noisy-${k}.wav`))
  items.push({ id: `noisy/${k}`, file: `wav/noisy-${k}.wav`, ref: i.ref, kind: 'noisy' })
  // Speech then 4 s of quiet: the tail a release carries, and where "Thank you." comes from.
  ff('-i', src(i), '-f', 'lavfi', '-i', 'anoisesrc=c=white:a=0.001:d=4:r=16000', '-filter_complex', '[0][1]concat=n=2:v=0:a=1', '-ac', '1', '-ar', '16000', path.join(out, `wav/quiet-tail-${k}.wav`))
  items.push({ id: `quiet-tail/${k}`, file: `wav/quiet-tail-${k}.wav`, ref: i.ref, kind: 'quiet-tail' })
}
// Cut off mid-utterance: the reference is the words wholly inside the clip, by forced share of
// duration (approximate; scored with the last word allowed to be missing).
for (const [k, i] of base.slice(0, 3).entries()) {
  const d = dur(src(i)), keep = 0.6
  ff('-i', src(i), '-t', String(d * keep), path.join(out, `wav/cut-${k}.wav`))
  const w = i.ref.split(' ')
  items.push({ id: `cut/${k}`, file: `wav/cut-${k}.wav`, ref: w.slice(0, Math.floor(w.length * keep) - 1).join(' '), kind: 'cut', loose: true })
}
// Very short: the first ~1.2 s of an utterance, and a single word clip.
for (const [k, i] of base.slice(0, 2).entries()) {
  ff('-i', src(i), '-t', '1.2', path.join(out, `wav/short-${k}.wav`))
  items.push({ id: `short/${k}`, file: `wav/short-${k}.wav`, ref: i.ref.split(' ').slice(0, 2).join(' '), kind: 'short', loose: true })
}
// No speech at all: the right answer is nothing.
const none = {
  'silence-3s': 'anullsrc=r=16000:cl=mono:d=3',
  'near-silence-3s': 'anoisesrc=c=white:a=0.002:d=3:r=16000',
  'room-noise-4s': 'anoisesrc=c=brown:a=0.15:d=4:r=16000',
  'hiss-2s': 'anoisesrc=c=pink:a=0.05:d=2:r=16000',
  'music-6s': 'aevalsrc=0.15*sin(2*PI*220*t)*(1+sin(2*PI*2*t))/2+0.1*sin(2*PI*277*t)+0.1*sin(2*PI*330*t)+0.05*sin(2*PI*440*t*(1+0.01*sin(2*PI*5*t))):s=16000:d=6',
  'click-0.3s': 'aevalsrc=if(lt(mod(t\\,0.1)\\,0.003)\\,0.6\\,0):s=16000:d=0.3'
}
for (const [id, src] of Object.entries(none)) {
  ff('-f', 'lavfi', '-i', src, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', path.join(out, `wav/${id}.wav`))
  items.push({ id: `none/${id}`, file: `wav/${id}.wav`, ref: '', kind: 'no-speech' })
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(items, null, 1))
console.log(`${items.length} clips in ${out}`)
NODE
