"""A stand-in speech model for the emulator demo: answers /v1/audio/transcriptions with whatever
text the demo script put in NEXT_TEXT, and serves a plain text area at /pad to dictate into."""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

NEXT = os.environ.get("NEXT_TEXT", "/tmp/next.txt")
PAD = b"""<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Notes</title><style>body{font:18px sans-serif;margin:16px}
textarea{width:100%;height:40vh;font:20px sans-serif;padding:8px;box-sizing:border-box}</style>
<h3>Notes</h3><textarea id=t autofocus></textarea>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.end_headers()
        self.wfile.write(PAD)

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        self.rfile.read(length)
        text = open(NEXT).read().strip() if os.path.exists(NEXT) else ""
        print("transcribe ->", text, flush=True)
        body = json.dumps({"text": text, "duration": 3.0}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
