"""Whisper turbo (the sherpa-onnx int8 export) decoded greedily with onnxruntime, honouring a prompt
(read as the text before the audio, as the OpenAI API does). pip install onnxruntime librosa tiktoken."""
import base64, numpy as np, onnxruntime as ort, librosa, tiktoken
import os
M = os.environ.get('MURMUR_MODELS', 'models') + '/sherpa-onnx-whisper-turbo'
so = ort.SessionOptions(); so.intra_op_num_threads = 4
enc = ort.InferenceSession(f'{M}/turbo-encoder.int8.onnx', so, providers=['CPUExecutionProvider'])
dec = ort.InferenceSession(f'{M}/turbo-decoder.int8.onnx', so, providers=['CPUExecutionProvider'])
ranks = {}
for line in open(f'{M}/turbo-tokens.txt', encoding='utf8'):
    t, i = line.rstrip('\n').split(' ')
    if int(i) < 50257: ranks[base64.b64decode(t)] = int(i)
tok = tiktoken.Encoding('w', pat_str=r"""'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+""", mergeable_ranks=ranks, special_tokens={})
FILT = librosa.filters.mel(sr=16000, n_fft=400, n_mels=128)
EOT, SOT_PREV, NOTS = 50257, 50362, 50364
SOT_SEQ = [50258, 50259, 50360]

def mel(x):
    x = np.pad(x.astype(np.float32), (0, max(0, 480000 - len(x))))[:480000]
    st = librosa.stft(x, n_fft=400, hop_length=160, window='hann', center=True, pad_mode='reflect')
    mag = np.abs(st[:, :-1]) ** 2
    m = np.log10(np.clip(FILT @ mag, 1e-10, None))
    m = np.maximum(m, m.max() - 8.0)
    return ((m + 4.0) / 4.0)[None].astype(np.float32)

def transcribe(x, prompt=None):
    ck, cv = enc.run(None, {'mel': mel(x)})
    pre = []
    if prompt:
        pre = [SOT_PREV] + tok.encode(' ' + prompt.strip())[-223:]
    tokens = pre + SOT_SEQ + [NOTS]
    k = np.zeros((4, 1, 448, 1280), np.float32); v = np.zeros_like(k)
    out = []; cur = tokens; offset = 0
    while len(tokens) + len(out) < 440:
        logits, k, v = dec.run(None, {'tokens': np.array([cur], np.int64), 'in_n_layer_self_k_cache': k, 'in_n_layer_self_v_cache': v, 'n_layer_cross_k': ck, 'n_layer_cross_v': cv, 'offset': np.array([offset], np.int64)})
        offset += len(cur)
        nxt = int(np.argmax(logits[0, -1, :EOT + 1]))
        if nxt == EOT: break
        out.append(nxt); cur = [nxt]
        if len(out) > 8 and out[-4:] * 2 == out[-8:]: break  # a loop
    return tok.decode(out).strip()

if __name__ == '__main__':
    import sys, soundfile as sf, time
    for f in sys.argv[1:]:
        x, _ = sf.read(f, dtype='float32'); t = time.time()
        print(round(time.time() - t, 1), repr(transcribe(x[:16000 * 25])))
        print(repr(transcribe(x[:16000 * 25], 'Dictation with punctuation.')))
