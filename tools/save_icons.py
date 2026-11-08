"""Receive the PNG icons drawn by tools/make-icons.html and write them into icons/.

There is no image library on this machine, so the icons are drawn by the browser on a <canvas>.
Opening http://localhost:8080/tools/make-icons.html?post=1 POSTs every PNG here as text/plain
JSON {"name": "icon-512.png", "base64": "..."}; this script validates and saves them.

Usage:
  python tools/save_icons.py          -> listens on http://127.0.0.1:8766/ and exits after the
                                         four files or 120 seconds, whichever comes first.
"""
import base64
import http.server
import json
import os
import sys
import time

# Windows consoles and pipes may use cp949: never crash on an accented letter.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS_DIR = os.path.join(ROOT, "icons")
ALLOWED = {"icon-512.png", "maskable-512.png", "icon-192.png", "apple-touch-icon.png"}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
HOST = "127.0.0.1"
PORT = 8766
TIMEOUT_SECONDS = 120

saved = set()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet: we print our own lines
        pass

    def _reply(self, code, text):
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 5_000_000:
            self._reply(400, "cuerpo vacío o demasiado grande")
            return
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
            name = data["name"]
            png = base64.b64decode(data["base64"], validate=True)
        except (ValueError, KeyError, TypeError) as err:
            self._reply(400, f"JSON inválido: {err}")
            return
        if name not in ALLOWED:
            self._reply(400, f"nombre no permitido: {name}")
            print(f"rechazado: {name}")
            return
        if not png.startswith(PNG_SIGNATURE):
            self._reply(400, "no es un PNG")
            print(f"rechazado (no es PNG): {name}")
            return
        os.makedirs(ICONS_DIR, exist_ok=True)
        path = os.path.join(ICONS_DIR, name)
        with open(path, "wb") as fh:
            fh.write(png)
        saved.add(name)
        print(f"guardado: {os.path.relpath(path, ROOT)} ({len(png)} bytes)")
        self._reply(200, "ok")


def main():
    try:
        server = http.server.HTTPServer((HOST, PORT), Handler)
    except OSError as err:
        print(f"No se pudo abrir el puerto {PORT}: {err}")
        sys.exit(1)
    server.timeout = 1  # handle_request() returns every second so the deadline can be checked
    deadline = time.monotonic() + TIMEOUT_SECONDS
    print(f"Esperando iconos en http://{HOST}:{PORT}/  (abre tools/make-icons.html?post=1)")
    while time.monotonic() < deadline and saved != ALLOWED:
        server.handle_request()
    server.server_close()
    missing = sorted(ALLOWED - saved)
    if missing:
        print("Faltan: " + ", ".join(missing))
        sys.exit(1)
    print("Los 4 iconos están en icons/")


if __name__ == "__main__":
    main()
