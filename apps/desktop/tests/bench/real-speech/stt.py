import sherpa_onnx, soundfile as sf, numpy as np, time, sys
import os
M=os.environ.get('MURMUR_MODELS', 'models') + '/sherpa-onnx-whisper-turbo'
rec = sherpa_onnx.OfflineRecognizer.from_whisper(encoder=f'{M}/turbo-encoder.int8.onnx', decoder=f'{M}/turbo-decoder.int8.onnx', tokens=f'{M}/turbo-tokens.txt', language='en', task='transcribe', num_threads=4, tail_paddings=-1)
def transcribe(x):
    s = rec.create_stream(); s.accept_waveform(16000, x); rec.decode_stream(s); return s.result
if __name__ == '__main__':
    for f in sys.argv[1:]:
        x, sr = sf.read(f, dtype='float32')
        t = time.time(); r = transcribe(x)
        print(f, round(len(x)/sr,1), 's', round(time.time()-t,2), 's:', repr(r.text), r.timestamps[:3] if r.timestamps else None)
