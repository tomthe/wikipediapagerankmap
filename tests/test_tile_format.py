"""Round-trip check: Python encoder -> JavaScript decoder.

The tile format is written in one language and read in another, so the only
check worth having is one that runs both. This encodes awkward tiles (odd row
counts, which exercise the alignment padding; astral-plane and RTL titles;
items with and without an English article) and asserts the browser decoder
reproduces them exactly.

    python -m tests.test_tile_format

Needs a JS runtime. Set NODE_BIN, or it will look for node on PATH and then
fall back to VS Code's bundled Electron.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from pipeline.build_tiles import FLAG_HAS_IMAGE, FLAG_HAS_WIKI, encode_tile

REPO = Path(__file__).resolve().parent.parent


def find_node() -> tuple[list[str], dict[str, str]]:
    env = dict(os.environ)
    explicit = env.get("NODE_BIN")
    if explicit:
        return [explicit], env
    on_path = shutil.which("node")
    if on_path:
        return [on_path], env
    vscode = Path(
        env.get("LOCALAPPDATA", "")
    ) / "Programs" / "Microsoft VS Code" / "Code.exe"
    if vscode.exists():
        env["ELECTRON_RUN_AS_NODE"] = "1"
        return [str(vscode)], env
    sys.exit("no JS runtime found; set NODE_BIN to a node executable")


CASES = [
    {
        "name": "odd row count with unicode",
        "rows": [
            # (qid, lon, lat, score, pr, qr, cat, sub, flags, title, wiki)
            # "en|" = English article whose title equals the drawn label
            (90, -0.1276, 51.5072, 65535, 60000, 64000, 1, 2, FLAG_HAS_WIKI | FLAG_HAS_IMAGE, "London", "en|"),
            (1490, 139.6917, 35.6895, 65000, 59000, 65535, 1, 2, FLAG_HAS_WIKI, "東京", "en|Tokyo"),
            (3766, 34.7818, 32.0853, 40000, 30000, 35000, 1, 2, FLAG_HAS_WIKI, "תל אביב", "en|Tel Aviv"),
            # only a non-English article, and the title differs from the label
            (5678, 11.582, 48.1351, 30000, 20000, 25000, 1, 2, FLAG_HAS_WIKI, "Munich", "de|München"),
            # a bot-made wiki with a longer language code
            (91011, 121.0, 14.0, 900, 400, 500, 2, 1, FLAG_HAS_WIKI, "Barangay X", "ceb|"),
            (12345, 2.3522, 48.8566, 100, 50, 70, 2, 1, 0, "Sans article 😀", ""),
            (7, -74.006, 40.7128, 1, 0, 0, 0, 0, 0, "Q7 only", ""),
        ],
    },
    {
        "name": "single row",
        "rows": [(1, 0.0, 0.0, 32768, 100, 200, 8, 3, FLAG_HAS_WIKI, "Null Island", "en|Null_Island")],
    },
    {
        "name": "two rows, no articles",
        "rows": [
            (2, 180.0, -85.0, 5, 1, 2, 3, 0, 0, "Edge A", ""),
            (3, -180.0, 85.0, 6, 2, 3, 4, 1, 0, "Edge B", ""),
        ],
    },
]


def build(rows) -> tuple[bytes, list[dict]]:
    cols = list(zip(*rows))
    payload = encode_tile(
        {
            "qid": np.array(cols[0], dtype=np.uint32),
            "lon": np.array(cols[1], dtype=np.float64),
            "lat": np.array(cols[2], dtype=np.float64),
            "score": np.array(cols[3], dtype=np.uint16),
            "pr": np.array(cols[4], dtype=np.uint16),
            "qr": np.array(cols[5], dtype=np.uint16),
            "cat": np.array(cols[6], dtype=np.uint8),
            "sub": np.array(cols[7], dtype=np.uint8),
            "flags": np.array(cols[8], dtype=np.uint8),
            "title": list(cols[9]),
            "wiki": list(cols[10]),
        },
        z=5,
        x=17,
        y=11,
    )
    expected = []
    for r in rows:
        wiki = wiki_lang = None
        if r[8] & FLAG_HAS_WIKI:
            lang, _, article = r[10].partition("|")
            wiki_lang = lang
            wiki = article or r[9]
        expected.append(
            {
                "qid": r[0],
                "lon": round(float(np.float32(r[1])), 4),
                "lat": round(float(np.float32(r[2])), 4),
                "title": r[9],
                "wiki": wiki,
                "wikiLang": wiki_lang,
                "hasImage": bool(r[8] & FLAG_HAS_IMAGE),
                "cat": r[6],
                "sub": r[7],
                "score": round(r[3] / 65535, 3),
                "pr": round(r[4] / 65535, 3),
                "qr": round(r[5] / 65535, 3),
            }
        )
    return payload, expected


def main() -> None:
    node, env = find_node()
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        for case in CASES:
            payload, expected = build(case["rows"])
            path = Path(tmp) / "tile.bin"
            path.write_bytes(payload)
            proc = subprocess.run(
                node + [str(REPO / "tests" / "decode_tile.mjs"), str(path)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                env=env,
                cwd=REPO,
            )
            if proc.returncode != 0:
                print(f"FAIL {case['name']}: decoder exited {proc.returncode}")
                print(proc.stderr.strip()[:2000])
                failures += 1
                continue
            got = json.loads(proc.stdout)
            if got["z"] != 5 or got["x"] != 17 or got["y"] != 11:
                print(f"FAIL {case['name']}: header {got['z']}/{got['x']}/{got['y']}")
                failures += 1
                continue
            if got["items"] != expected:
                print(f"FAIL {case['name']}: rows differ")
                for a, b in zip(got["items"], expected):
                    if a != b:
                        print(f"   decoded {a}")
                        print(f"   expected {b}")
                failures += 1
                continue
            print(f"ok   {case['name']} ({len(expected)} rows, {len(payload)} bytes)")

    if failures:
        sys.exit(f"{failures} case(s) failed")
    print("tile format round-trips")


if __name__ == "__main__":
    main()
