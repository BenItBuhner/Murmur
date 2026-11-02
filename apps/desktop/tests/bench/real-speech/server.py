import json, io, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np, soundfile as sf
from stt import transcribe
lock = threading.Lock()
def quietest(x, a, b):
    f = 320; best = a; bv = 1e9
    for i in range(a, b - f, f):
        v = float(np.mean(x[i:i+f]**2))
        if v < bv: bv, best = v, i + f // 2
    return best
def stt(x):
    out = []
    while len(x) > 29 * 16000:
        c = quietest(x, 20 * 16000, 29 * 16000)
        out.append(x[:c]); x = x[c:]
    out.append(x)
    texts = []
    for p in out:
        with lock: texts.append(transcribe(p).text.strip())
    return ' '.join(t for t in texts if t)
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers['content-length']); body = self.rfile.read(n)
        x, sr = sf.read(io.BytesIO(body), dtype='float32')
        text = stt(x) if len(x) > 1600 else ''
        b = json.dumps({'text': text, 'duration': len(x) / sr}).encode()
        self.send_response(200); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
ThreadingHTTPServer(('127.0.0.1', 8765), H).serve_forever()
