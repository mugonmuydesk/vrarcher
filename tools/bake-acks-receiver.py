#!/usr/bin/env python3
# One-off bake helper: receives baked ACK clip WAVs from the browser bake routine
# (debug/bake-acks-gemini.js) and writes them to assets/acks/. The browser POSTs
# base64(WAV) as text/plain to http://127.0.0.1:8078/save?name=akNN.wav (text/plain
# keeps it a CORS "simple request" — no preflight; we still send ACAO:*). Mirrors
# tools/bake-fillers-receiver.py; differs only in port (8078) and output dir.
# Run from the repo root:  python3 tools/bake-acks-receiver.py
# Re-run the bake whenever the shipping Gemini voice/style or the ACK line banks change.
import base64, os, http.server, urllib.parse

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "acks")
OUT = os.path.abspath(OUT)
os.makedirs(OUT, exist_ok=True)

class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
    def do_OPTIONS(self):
        self.send_response(204); self._cors()
        self.send_header("Access-Control-Allow-Methods", "POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
    def do_POST(self):
        q = urllib.parse.urlparse(self.path)
        name = os.path.basename(urllib.parse.parse_qs(q.query).get("name", ["x.bin"])[0])
        n = int(self.headers.get("Content-Length", 0))
        data = base64.b64decode(self.rfile.read(n))
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        print(f"wrote {name} ({len(data)} bytes)")
        self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a):
        pass

print(f"bake receiver on http://127.0.0.1:8078  ->  {OUT}")
http.server.HTTPServer(("127.0.0.1", 8078), H).serve_forever()
