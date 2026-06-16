# Bake-output receiver: accepts PNG POSTs from the bake page and writes
# them into assets/lightmaps/. Run from the repo root:
#   python3 tools/bake/receiver.py   (listens on :8002)
import http.server
import pathlib
import re

OUT = pathlib.Path(__file__).resolve().parents[2] / "assets" / "lightmaps"


class Handler(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        log = re.fullmatch(r"/log/([a-zA-Z0-9_-]{1,40})", self.path)
        if log:
            body = self.rfile.read(int(self.headers["Content-Length"]))
            print(f"[{log.group(1)}] {body.decode('utf-8', 'replace')}", flush=True)
            self.send_response(200)
            self._cors()
            self.end_headers()
            return
        name = re.fullmatch(r"/save/([a-zA-Z0-9_-]{1,40})", self.path)
        if not name:
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        data = self.rfile.read(int(self.headers["Content-Length"]))
        OUT.mkdir(parents=True, exist_ok=True)
        path = OUT / f"{name.group(1)}.png"
        path.write_bytes(data)
        print(f"wrote {path} ({len(data)} bytes)")
        self.send_response(200)
        self._cors()
        self.end_headers()


http.server.HTTPServer(("127.0.0.1", 8002), Handler).serve_forever()
