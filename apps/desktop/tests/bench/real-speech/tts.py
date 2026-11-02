"""Spoken dictations for the real-speech eval: eval/long samples + short ones, read by several
voices with natural pauses, mid-sentence hesitations, room noise and varied endings."""
import json, random, re, sys, os
import numpy as np, sherpa_onnx, soundfile as sf

M = os.environ.get('MURMUR_MODELS', 'models')
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
def piper(name):
    d = f'{M}/vits-piper-{name}'
    onnx = [f for f in os.listdir(d) if f.endswith('.onnx')][0]
    return sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        vits=sherpa_onnx.OfflineTtsVitsModelConfig(model=f'{d}/{onnx}', tokens=f'{d}/tokens.txt', data_dir=f'{d}/espeak-ng-data'), num_threads=4)))
ENGINES = {n: piper(n) for n in ['en_US-amy-medium', 'en_GB-alan-medium', 'en_US-ryan-medium', 'en_US-libritts_r-medium']}
SR = 16000
def say(text, voice, speed):
    name, sid = voice
    a = ENGINES[name].generate(text, sid=sid, speed=speed)
    x = np.array(a.samples, dtype=np.float32)
    n = int(len(x) * SR / a.sample_rate)
    x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    # trim TTS's own leading/trailing silence so pauses are ours
    nz = np.where(np.abs(x) > 0.003)[0]
    return x[max(0, nz[0] - 1600): nz[-1] + 3200] if len(nz) else x

def sil(sec): return np.zeros(int(sec * SR), np.float32)

def load_long():
    d = os.path.join(os.path.dirname(__file__), '../../../../../packages/text-engine/eval/long')
    out = []
    for f in sorted(os.listdir(d)):
        lines = open(f'{d}/{f}').read().split('\n')[1:]
        sents = [re.sub(r'^(\d+\)|-)\s+', '', l).strip() for l in lines if l.strip()]
        out.append((f[:-4], sents))
    return out

SHORT = [
  ('short-1', ["Can you send me the slides from this morning before the call?"]),
  ('short-2', ["Sounds good, I will be there at three."]),
  ('short-3', ["Remind me to renew the domain on Friday, and also check the invoice from last month."]),
  ('short-4', ["Hey, quick question about the release.", "Are we still shipping the Android build tomorrow, or did that move to next week?"]),
  ('short-5', ["Thanks for the update.", "I looked at the numbers and they look right to me.", "Thank you."]),
  ('short-6', ["I think we should push the meeting to Thursday because half the team is out on Wednesday."]),
]

VOICES = [('en_US-amy-medium', 0), ('en_US-libritts_r-medium', 14), ('en_GB-alan-medium', 0), ('en_US-libritts_r-medium', 301), ('en_US-ryan-medium', 0), ('en_US-libritts_r-medium', 640), ('en_US-libritts_r-medium', 88)]
rng = random.Random(7)
meta = []
items = [(i, s, True) for i, s in load_long()] + [(i, s, False) for i, s in SHORT]
# long ones also read a second time by another voice, ending with a spoken "thank you"
items += [(i + '-thanks', s + ['Thank you.'], True) for i, s in load_long()[:3]]
for k, (id_, sents, long) in enumerate(items):
    voice = VOICES[k % len(VOICES)]
    speed = rng.choice([0.9, 1.0, 1.1])  # piper length_scale-ish: >1 faster
    parts = [sil(rng.uniform(0.3, 0.8))]
    for j, s in enumerate(sents):
        # a hesitation mid-sentence: split at a comma or after a few words, pause 0.7-1.6 s
        if long and len(s.split()) > 12 and rng.random() < 0.35:
            w = s.split(); c = rng.randint(4, len(w) - 4)
            parts += [say(' '.join(w[:c]), voice, speed), sil(rng.uniform(0.7, 1.6)), say(' '.join(w[c:]), voice, speed)]
        else:
            parts.append(say(s, voice, speed))
        if j < len(sents) - 1:
            parts.append(sil(rng.uniform(0.15, 0.6) if rng.random() < 0.8 else rng.uniform(1.2, 2.5)))
    ending = ['quiet', 'long-quiet', 'breath', 'click', 'rustle'][k % 5]
    tail = {'quiet': 0.4, 'long-quiet': 2.5, 'breath': 1.2, 'click': 1.0, 'rustle': 1.5}[ending]
    end = sil(tail)
    if ending == 'breath':
        b = np.random.default_rng(k).normal(0, 0.02, int(0.35 * SR)).astype(np.float32) * np.hanning(int(0.35 * SR)).astype(np.float32)
        end[int(0.3 * SR): int(0.3 * SR) + len(b)] += b
    if ending == 'rustle':
        b = np.random.default_rng(k).normal(0, 0.06, int(0.6 * SR)).astype(np.float32) * np.hanning(int(0.6 * SR)).astype(np.float32)
        end[int(0.5 * SR): int(0.5 * SR) + len(b)] += b
    if ending == 'click':
        end[int(0.5 * SR): int(0.5 * SR) + 80] += np.random.default_rng(k).normal(0, 0.3, 80).astype(np.float32)
    parts.append(end)
    x = np.concatenate(parts)
    # room noise at ~35-45 dB below speech
    x += np.random.default_rng(100 + k).normal(0, rng.uniform(0.001, 0.004), len(x)).astype(np.float32)
    x = np.clip(x, -1, 1)
    sf.write(f'{OUT}/{id_}.wav', (x * 32767).astype(np.int16), SR, subtype='PCM_16')
    meta.append({'id': id_, 'text': ' '.join(sents), 'voice': str(voice), 'speed': speed, 'ending': ending, 'sec': round(len(x) / SR, 1)})
    print(id_, voice, ending, round(len(x) / SR, 1), flush=True)
json.dump(meta, open(f'{OUT}/meta.json', 'w'), indent=1)
