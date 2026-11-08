"""Stamp a release before deploying (Python 3 standard library only).

What it does:
  1. VERSION = UTC timestamp 'YYYYMMDD-HHMMSS'.
  2. Scans the project for the files the service worker must precache:
       ./  ./index.html  ./styles.css  ./manifest.webmanifest
       js/**/*.js (except js/tests.js and js/tests/**), vendor/*.js, seeds/*.json, icons/*.png|svg
  3. Rewrites the marked blocks in sw.js (VERSION, PRECACHE) and js/version.js (APP_VERSION).
  4. Verifies that every listed file exists and that the manifest icons are present.

Usage:
  python tools/release.py                 stamp a new version (deploy.bat does this)
  python tools/release.py --check         exit 1 when sw.js / version.js are out of date, write nothing
  python tools/release.py --print-version print the version currently stamped in js/version.js

Never edit VERSION / PRECACHE / APP_VERSION by hand: run this script instead.
"""
import datetime
import os
import re
import sys

# Windows consoles and pipes may use cp949: never crash on an accented letter.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SW_PATH = os.path.join(ROOT, "sw.js")
VERSION_PATH = os.path.join(ROOT, "js", "version.js")

FIXED_ENTRIES = ["./", "./index.html", "./styles.css", "./manifest.webmanifest"]
REQUIRED_ICONS = ["icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png"]
FORBIDDEN_PARTS = ("test.html", "js/tests", "tools/", "docs/")

# The markers accept LF or CRLF: a git checkout with core.autocrlf=true rewrites the files with CRLF
# (.gitattributes forces LF, but the stamping must never depend on it).
SW_VERSION_RE = re.compile(r"(// @release-version\r?\n)(.*?)(// @release-version-end)", re.S)
SW_PRECACHE_RE = re.compile(r"(// @release-precache\r?\n)(.*?)(// @release-precache-end)", re.S)
APP_VERSION_RE = re.compile(r"(// @release-app-version\r?\n)(.*?)(// @release-app-version-end)", re.S)


def rel(path):
    """Project-relative path with forward slashes and a './' prefix."""
    return "./" + os.path.relpath(path, ROOT).replace(os.sep, "/")


def scan_dir(folder, keep, recursive=False):
    """Files under ROOT/folder whose relative path passes keep(relpath); sorted later."""
    base = os.path.join(ROOT, folder)
    found = []
    if not os.path.isdir(base):
        return found
    if recursive:
        for dirpath, _dirs, files in os.walk(base):
            for name in files:
                full = os.path.join(dirpath, name)
                if keep(rel(full)):
                    found.append(rel(full))
    else:
        for name in os.listdir(base):
            full = os.path.join(base, name)
            if os.path.isfile(full) and keep(rel(full)):
                found.append(rel(full))
    return found


def compute_precache():
    entries = list(FIXED_ENTRIES)
    entries += scan_dir(
        "js",
        lambda p: p.endswith(".js") and p != "./js/tests.js" and not p.startswith("./js/tests/"),
        recursive=True,
    )
    entries += scan_dir("vendor", lambda p: p.endswith(".js"))
    entries += scan_dir("seeds", lambda p: p.endswith(".json"))
    entries += scan_dir("icons", lambda p: p.endswith(".png") or p.endswith(".svg"))
    return sorted(set(entries))


def verify(entries):
    """Return a list of problems (empty when everything is fine)."""
    problems = []
    for entry in entries:
        if entry == "./":
            continue
        if any(part in entry for part in FORBIDDEN_PARTS):
            problems.append(f"entrada prohibida en la precarga: {entry}")
        full = os.path.join(ROOT, entry[2:].replace("/", os.sep))
        if not os.path.isfile(full):
            problems.append(f"archivo listado que no existe: {entry}")
    for icon in REQUIRED_ICONS:
        if not os.path.isfile(os.path.join(ROOT, icon.replace("/", os.sep))):
            problems.append(f"falta el icono {icon} (abre tools/make-icons.html, ver README)")
    for path in (SW_PATH, VERSION_PATH):
        if not os.path.isfile(path):
            problems.append(f"falta {os.path.relpath(path, ROOT)}")
    return problems


def read(path):
    with open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def find_block(regex, text, what):
    match = regex.search(text)
    if not match:
        raise SystemExit(f"marcadores '{what}' no encontrados; restaura el archivo desde git")
    return match


def current_sw_version(sw_text):
    block = find_block(SW_VERSION_RE, sw_text, "@release-version").group(2)
    match = re.search(r"const VERSION = '([^']*)';", block)
    return match.group(1) if match else None


def current_sw_precache(sw_text):
    block = find_block(SW_PRECACHE_RE, sw_text, "@release-precache").group(2)
    return re.findall(r"'([^']*)'", block)


def current_app_version(version_text):
    block = find_block(APP_VERSION_RE, version_text, "@release-app-version").group(2)
    match = re.search(r"export const APP_VERSION = '([^']*)';", block)
    return match.group(1) if match else None


def newline_of(text):
    """The line ending the file already uses ('\\r\\n' after a CRLF checkout), so we never mix them."""
    return "\r\n" if "\r\n" in text else "\n"


def precache_source(entries, nl="\n"):
    lines = ["const PRECACHE = ["]
    for entry in entries:
        lines.append(f"  '{entry}',")
    lines.append("];")
    return nl.join(lines) + nl


def replace_block(regex, text, body, what):
    """Put body between the markers. Fails loudly when the markers are missing: a silent no-op
    would let deploy.bat publish the OLD version (phones would never see the update banner)."""
    new_text, count = regex.subn(lambda m: m.group(1) + body + m.group(3), text, count=1)
    if count != 1:
        raise SystemExit(f"marcadores '{what}' no encontrados; restaura el archivo desde git")
    return new_text


def stamp(version, entries):
    sw_text = read(SW_PATH)
    nl = newline_of(sw_text)
    sw_text = replace_block(SW_VERSION_RE, sw_text, f"const VERSION = '{version}';{nl}", "@release-version")
    sw_text = replace_block(SW_PRECACHE_RE, sw_text, precache_source(entries, nl), "@release-precache")
    write(SW_PATH, sw_text)

    version_text = read(VERSION_PATH)
    nl = newline_of(version_text)
    version_text = replace_block(
        APP_VERSION_RE, version_text, f"export const APP_VERSION = '{version}';{nl}", "@release-app-version"
    )
    write(VERSION_PATH, version_text)


def check(entries):
    """Exit 1 when sw.js / version.js do not match the project on disk."""
    sw_text = read(SW_PATH)
    version_text = read(VERSION_PATH)
    stale = []
    listed = current_sw_precache(sw_text)
    if listed != entries:
        missing = [e for e in entries if e not in listed]
        extra = [e for e in listed if e not in entries]
        if missing:
            stale.append("faltan en sw.js: " + ", ".join(missing))
        if extra:
            stale.append("sobran en sw.js: " + ", ".join(extra))
        if not missing and not extra:
            stale.append("el orden de PRECACHE no es el ordenado")
    sw_version = current_sw_version(sw_text)
    app_version = current_app_version(version_text)
    if not sw_version or sw_version == "dev":
        stale.append("sw.js no tiene versión (VERSION = 'dev')")
    if sw_version != app_version:
        stale.append(f"versiones distintas: sw.js {sw_version} / js/version.js {app_version}")
    if stale:
        print("sw.js está desactualizado:")
        for line in stale:
            print("  - " + line)
        print("Ejecuta: python tools/release.py")
        sys.exit(1)
    print(f"sw.js al día: versión {sw_version}, {len(entries)} archivos en la precarga")


def main():
    args = sys.argv[1:]
    if "--print-version" in args:
        print(current_app_version(read(VERSION_PATH)) or "dev")
        return

    entries = compute_precache()
    problems = verify(entries)
    if problems:
        print("No se puede publicar:")
        for line in problems:
            print("  - " + line)
        sys.exit(1)

    if "--check" in args:
        check(entries)
        return

    version = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    stamp(version, entries)
    print(f"Versión {version}: {len(entries)} archivos en la precarga (sw.js y js/version.js actualizados)")


if __name__ == "__main__":
    main()
