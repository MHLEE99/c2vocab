#!/usr/bin/env python3
"""Check a c2vocab export file (the "envelope" written by Ajustes > Exportar todo).

Usage:
    python tools/verify_export.py <file.json>

It validates the envelope, every card against the card contract, duplicate ids,
duplicate expressions among live cards, and the review log. It then prints some
counts. Exit code 0 when the file is valid, 1 when problems were found.

Python 3 standard library only.
"""

import json
import re
import sys
import unicodedata
from collections import Counter

SCHEMA_VERSION = 1

TYPES = [
    "locucion", "colocacion", "refran", "marcador", "falso_amigo", "verbo_prep",
    "variante", "expresion", "lexico", "estructura", "otro",
]
REGISTERS = ["", "culto", "neutro", "coloquial", "vulgar"]
DIRECTIONS = ["both", "rec", "prod"]
STATUSES = ["inbox", "active", "suspended"]
SRS_STATES = ["new", "learning", "review", "relearning"]
SRS_DIRS = ["rec", "prod"]

STRING_KEYS = [
    "id", "type", "front", "back", "ko", "example", "exampleSource", "register",
    "region", "contraste", "source", "notes", "direction", "status",
    "createdAt", "updatedAt",
]
CARD_KEYS = STRING_KEYS + [
    "exampleVerified", "tags", "colocaciones", "equivalentes", "deletedAt", "srs",
]
SRS_KEYS = ["state", "due", "intervalDays", "ease", "step", "reps", "lapses", "lastReviewAt"]

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")

MAX_PROBLEMS_SHOWN = 200


def is_iso(value):
    """True for an ISO 8601 timestamp such as 2026-10-03T09:00:00.000Z."""
    return isinstance(value, str) and ISO_RE.match(value) is not None


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def normalize(text):
    """Same result as normalize() in js/util.js: no accents, lowercase, single spaces; n-tilde kept."""
    if text is None:
        return ""
    s = unicodedata.normalize("NFC", str(text))
    s = s.replace("ñ", "").replace("Ñ", "")
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if not ("̀" <= ch <= "ͯ"))
    s = s.lower()
    s = s.replace("", "ñ").replace("", "ñ")
    return re.sub(r"\s+", " ", s).strip()


def dup_key(front, card_type):
    """Same as dupKey() in js/db.js."""
    return normalize(front) + "|" + str(card_type or "")


def check_srs_state(label, state, problems):
    if not isinstance(state, dict):
        problems.append(f"{label}: no es un objeto")
        return
    for key in SRS_KEYS:
        if key not in state:
            problems.append(f"{label}: falta la clave '{key}'")
    if state.get("state") not in SRS_STATES:
        problems.append(f"{label}: state no válido: {state.get('state')!r}")
    for key in ("intervalDays", "ease", "step", "reps", "lapses"):
        if key in state and not is_number(state[key]):
            problems.append(f"{label}: {key} debe ser un número")
    for key in ("due", "lastReviewAt"):
        value = state.get(key)
        if value is not None and not is_iso(value):
            problems.append(f"{label}: {key} no es una fecha ISO: {value!r}")
    if state.get("state") == "new" and state.get("due") is not None:
        problems.append(f"{label}: una tarjeta nueva no debe tener 'due'")
    if state.get("state") in ("learning", "review", "relearning") and state.get("due") is None:
        problems.append(f"{label}: falta 'due' en el estado {state.get('state')}")


def check_card(index, card, problems):
    """Validate one card. Returns its id (or None when it has no usable id)."""
    if not isinstance(card, dict):
        problems.append(f"cards[{index}]: no es un objeto")
        return None
    card_id = card.get("id")
    label = f"cards[{index}] ({card.get('front')!r})"

    for key in CARD_KEYS:
        if key not in card:
            problems.append(f"{label}: falta la clave '{key}'")
    for key in STRING_KEYS:
        if key in card and not isinstance(card[key], str):
            problems.append(f"{label}: '{key}' debe ser texto")

    if not isinstance(card_id, str) or card_id.strip() == "":
        problems.append(f"{label}: id vacío o no válido")
        card_id = None
    front = card.get("front")
    if not isinstance(front, str) or front.strip() == "":
        problems.append(f"{label}: front vacío")
    elif front != front.strip():
        problems.append(f"{label}: front con espacios al principio o al final")

    if "type" in card and card["type"] not in TYPES:
        problems.append(f"{label}: type no válido: {card['type']!r}")
    if "register" in card and card["register"] not in REGISTERS:
        problems.append(f"{label}: register no válido: {card['register']!r}")
    if "direction" in card and card["direction"] not in DIRECTIONS:
        problems.append(f"{label}: direction no válido: {card['direction']!r}")
    if "status" in card and card["status"] not in STATUSES:
        problems.append(f"{label}: status no válido: {card['status']!r}")

    back = card.get("back")
    if isinstance(back, str) and card.get("status") in STATUSES:
        if back.strip() == "" and card["status"] != "inbox":
            problems.append(f"{label}: back vacío pero status es '{card['status']}' (solo 'inbox' puede no tener definición)")
        if back.strip() != "" and card["status"] == "inbox":
            problems.append(f"{label}: status 'inbox' pero ya tiene definición")

    if "exampleVerified" in card and not isinstance(card["exampleVerified"], bool):
        problems.append(f"{label}: exampleVerified debe ser true o false")

    for key in ("createdAt", "updatedAt"):
        if key in card and not is_iso(card[key]):
            problems.append(f"{label}: {key} no es una fecha ISO: {card[key]!r}")
    if is_iso(card.get("createdAt")) and is_iso(card.get("updatedAt")) and card["updatedAt"] < card["createdAt"]:
        problems.append(f"{label}: updatedAt es anterior a createdAt")
    if "deletedAt" in card and card["deletedAt"] is not None and not is_iso(card["deletedAt"]):
        problems.append(f"{label}: deletedAt debe ser null o una fecha ISO: {card['deletedAt']!r}")

    tags = card.get("tags")
    if "tags" in card:
        if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
            problems.append(f"{label}: tags debe ser una lista de textos")
        else:
            for tag in tags:
                if tag == "" or tag != tag.strip().lower() or tag.startswith("#"):
                    problems.append(f"{label}: etiqueta mal formada: {tag!r}")
            if len(set(tags)) != len(tags):
                problems.append(f"{label}: etiquetas repetidas")

    colocaciones = card.get("colocaciones")
    if "colocaciones" in card:
        if not isinstance(colocaciones, list) or not all(isinstance(c, str) for c in colocaciones):
            problems.append(f"{label}: colocaciones debe ser una lista de textos")

    equivalentes = card.get("equivalentes")
    if "equivalentes" in card:
        if not isinstance(equivalentes, list):
            problems.append(f"{label}: equivalentes debe ser una lista")
        else:
            for n, item in enumerate(equivalentes):
                ok = (
                    isinstance(item, dict)
                    and isinstance(item.get("texto"), str)
                    and item.get("texto").strip() != ""
                    and isinstance(item.get("registro"), str)
                )
                if not ok:
                    problems.append(f"{label}: equivalentes[{n}] debe ser {{texto, registro}}")

    srs = card.get("srs")
    if "srs" in card:
        if not isinstance(srs, dict):
            problems.append(f"{label}: srs no es un objeto")
        else:
            for direction in SRS_DIRS:
                if direction not in srs:
                    problems.append(f"{label}: falta srs.{direction}")
                else:
                    check_srs_state(f"{label} srs.{direction}", srs[direction], problems)

    return card_id


def check_review(index, review, card_ids, problems):
    """Validate one review row. Returns its id (or None)."""
    if not isinstance(review, dict):
        problems.append(f"reviews[{index}]: no es un objeto")
        return None
    review_id = review.get("id")
    label = f"reviews[{index}] ({review_id!r})"
    if not isinstance(review_id, str) or review_id.strip() == "":
        problems.append(f"{label}: id vacío o no válido")
        review_id = None
    card_id = review.get("cardId")
    if not isinstance(card_id, str) or card_id == "":
        problems.append(f"{label}: falta cardId")
    elif card_id not in card_ids:
        problems.append(f"{label}: apunta a una tarjeta que no existe: {card_id}")
    rating = review.get("rating")
    if isinstance(rating, bool) or rating not in (1, 2, 3, 4):
        problems.append(f"{label}: rating debe ser 1, 2, 3 o 4: {rating!r}")
    if review.get("dir") not in SRS_DIRS:
        problems.append(f"{label}: dir no válido: {review.get('dir')!r}")
    if not is_iso(review.get("ts")):
        problems.append(f"{label}: ts no es una fecha ISO: {review.get('ts')!r}")
    if not isinstance(review.get("mode"), str) or review.get("mode") == "":
        problems.append(f"{label}: falta mode")
    undone = review.get("undoneAt")
    if undone is not None and not is_iso(undone):
        problems.append(f"{label}: undoneAt debe ser null o una fecha ISO: {undone!r}")
    return review_id


def check_envelope(doc):
    """Returns (problems, summary lines)."""
    problems = []
    summary = []

    if not isinstance(doc, dict):
        return ["el archivo no contiene un objeto JSON"], summary

    if doc.get("app") != "c2vocab":
        problems.append(f"app debe ser 'c2vocab': {doc.get('app')!r}")
    version = doc.get("schemaVersion")
    if not is_number(version):
        problems.append(f"schemaVersion debe ser un número: {version!r}")
    elif version > SCHEMA_VERSION:
        problems.append(f"schemaVersion {version} es más nuevo que este script ({SCHEMA_VERSION})")
    if not is_iso(doc.get("exportedAt")):
        problems.append(f"exportedAt no es una fecha ISO: {doc.get('exportedAt')!r}")
    for key in ("deviceId", "deviceName"):
        if not isinstance(doc.get(key), str):
            problems.append(f"{key} debe ser texto")
    if not isinstance(doc.get("settings"), dict):
        problems.append("settings debe ser un objeto")

    cards = doc.get("cards")
    reviews = doc.get("reviews")
    if not isinstance(cards, list):
        problems.append("cards debe ser una lista")
        cards = []
    if not isinstance(reviews, list):
        problems.append("reviews debe ser una lista")
        reviews = []

    # ---- cards
    id_counts = Counter()
    for index, card in enumerate(cards):
        card_id = check_card(index, card, problems)
        if card_id is not None:
            id_counts[card_id] += 1
    for card_id, count in id_counts.items():
        if count > 1:
            problems.append(f"id de tarjeta repetido {count} veces: {card_id}")

    live = [c for c in cards if isinstance(c, dict) and not c.get("deletedAt")]
    deleted = [c for c in cards if isinstance(c, dict) and c.get("deletedAt")]
    seen_keys = {}
    for card in live:
        if not isinstance(card.get("front"), str):
            continue
        key = dup_key(card.get("front"), card.get("type"))
        if key in seen_keys:
            problems.append(
                f"expresión duplicada entre tarjetas activas: {card.get('front')!r} / {seen_keys[key]!r} (tipo {card.get('type')})"
            )
        else:
            seen_keys[key] = card.get("front")

    # ---- reviews
    card_ids = set(id_counts.keys())
    review_ids = Counter()
    for index, review in enumerate(reviews):
        review_id = check_review(index, review, card_ids, problems)
        if review_id is not None:
            review_ids[review_id] += 1
    for review_id, count in review_ids.items():
        if count > 1:
            problems.append(f"id de repaso repetido {count} veces: {review_id}")

    # ---- summary
    undone = sum(1 for r in reviews if isinstance(r, dict) and r.get("undoneAt"))
    summary.append(f"Dispositivo: {doc.get('deviceName')!r}   exportado: {doc.get('exportedAt')}   schemaVersion: {version}")
    summary.append(f"Tarjetas: {len(cards)} en total = {len(live)} activas + {len(deleted)} en la papelera")

    by_type = Counter(str(c.get("type")) for c in live)
    summary.append("Por tipo (sin papelera):")
    for name in TYPES:
        if by_type.get(name):
            summary.append(f"  {name:<12} {by_type[name]}")
    for name, count in sorted(by_type.items()):
        if name not in TYPES:
            summary.append(f"  {name:<12} {count}  (tipo desconocido)")

    by_status = Counter(str(c.get("status")) for c in live)
    summary.append("Por estado (sin papelera):")
    for name, count in sorted(by_status.items()):
        summary.append(f"  {name:<12} {count}")

    for direction in SRS_DIRS:
        states = Counter()
        for card in live:
            srs = card.get("srs")
            state = srs.get(direction) if isinstance(srs, dict) else None
            states[str(state.get("state")) if isinstance(state, dict) else "?"] += 1
        parts = ", ".join(f"{name}: {count}" for name, count in sorted(states.items()))
        summary.append(f"SRS {direction}: {parts if parts else '-'}")

    summary.append(f"Repasos: {len(reviews)} en total, {undone} deshechos")
    return problems, summary


def main(argv):
    # UTF-8 output even on a Windows console (accents, Korean).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    if len(argv) != 2:
        print("Uso: python tools/verify_export.py <archivo.json>")
        return 1
    path = argv[1]
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            doc = json.load(handle)
    except OSError as err:
        print(f"No se puede abrir el archivo: {err}")
        return 1
    except ValueError as err:
        print(f"El archivo no es JSON válido: {err}")
        return 1

    problems, summary = check_envelope(doc)
    print(f"Archivo: {path}")
    for line in summary:
        print(line)
    print()
    if problems:
        print(f"PROBLEMAS: {len(problems)}")
        for line in problems[:MAX_PROBLEMS_SHOWN]:
            print(f"  - {line}")
        if len(problems) > MAX_PROBLEMS_SHOWN:
            print(f"  ... y {len(problems) - MAX_PROBLEMS_SHOWN} más")
        return 1
    print("OK: el archivo es válido.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
