"""Local static server for c2vocab (Python 3 standard library only).

Why not plain `python -m http.server`:
  - it lets the browser cache ES modules, so after the code changes a normal reload can
    run a mix of old and new files; this server sends `Cache-Control: no-store`;
  - on some Windows machines the registry maps .js to text/plain, which makes browsers
    refuse ES modules; this server always sends text/javascript.

Usage:
  python tools/serve.py            -> http://localhost:8080 (this computer only)
  python tools/serve.py 8090       -> another port
  python tools/serve.py --lan      -> also reachable from a phone on the same Wi-Fi
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update({
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    })

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    args = [a for a in sys.argv[1:]]
    lan = "--lan" in args
    ports = [a for a in args if a.isdigit()]
    port = int(ports[0]) if ports else 8080
    host = "0.0.0.0" if lan else "127.0.0.1"
    try:
        server = http.server.ThreadingHTTPServer((host, port), Handler)
    except OSError as err:
        print(f"No se pudo abrir el puerto {port}: {err}")
        print("이미 다른 창에서 앱 서버가 실행 중일 수 있습니다. 그 창을 닫고 다시 시도하세요.")
        sys.exit(1)
    print(f"c2vocab: http://localhost:{port}  (Ctrl+C para salir / 이 창을 닫으면 종료됩니다)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
