"""Stage 6 - a static prefix index so search needs no server.

Names are normalised (lowercase, accents stripped) and indexed under the first
1, 2 and 3 characters of the whole name and of each word, so "gate" finds
"Golden Gate Bridge".

  data/search/3/gol.json   complete list for that 3-character prefix
  data/search/2/go.json    top entries for that 2-character prefix
  data/search/1/g.json     top entries for that 1-character prefix

The client fetches the longest shard that exists for what has been typed, so a
query costs exactly one small request and the whole index never loads.

Entries are [name, lon, lat, qid, score, cat] - enough to render a result,
fly to it and build a link, with no second lookup.

Usage:
    python -m pipeline.build_search [--max-items 3000000]
"""

from __future__ import annotations

import argparse
import functools
import json
import shutil
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import polars as pl

from pipeline import config

print = functools.partial(print, flush=True)

TOP_PER_SHORT_SHARD = 2500
MAX_WORDS = 5

# Windows refuses to create these names even with an extension, and prefixes
# like "con" (Concord, Constantinople) turn up immediately in real data. The
# client applies the same rule in search.js - keep the two in step.
RESERVED_NAMES = {"con", "prn", "aux", "nul"} | {
    f"{stem}{i}" for stem in ("com", "lpt") for i in range(10)
}


def shard_filename(prefix: str) -> str:
    return f"{prefix}_.json" if prefix.lower() in RESERVED_NAMES else f"{prefix}.json"


def normalise(text: str) -> str:
    """Lowercase, strip accents, drop punctuation."""
    decomposed = unicodedata.normalize("NFKD", text.lower())
    kept = [
        ch
        for ch in decomposed
        if not unicodedata.combining(ch) and (ch.isalnum() or ch.isspace())
    ]
    return "".join(kept).strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-items", type=int, default=3_000_000)
    args = ap.parse_args()

    started = time.perf_counter()
    df = (
        pl.read_parquet(
            config.MASTER_PARQUET,
            columns=[
                "qid", "lon", "lat", "score", "cat",
                "label_en", "title_en", "native_label", "title_any",
            ],
        )
        .with_columns(
            # Same fallback chain the tiles draw, so search finds what is on screen.
            pl.coalesce(
                pl.col("label_en"),
                pl.col("title_en"),
                pl.col("native_label"),
                pl.col("title_any"),
            ).alias("name")
        )
        .drop_nulls("name")
        .sort("score", descending=True)
        .head(args.max_items)
    )
    print(f"indexing {len(df):,} items")

    names = df["name"].to_list()
    lons = df["lon"].to_list()
    lats = df["lat"].to_list()
    qids = df["qid"].to_list()
    scores = df["score"].to_list()
    cats = df["cat"].to_list()

    shards: dict[str, list] = {}
    seen: set[tuple[str, int]] = set()
    for i, raw_name in enumerate(names):
        norm = normalise(raw_name)
        if not norm:
            continue
        entry = [
            raw_name,
            round(lons[i], 5),
            round(lats[i], 5),
            qids[i],
            round(scores[i], 4),
            cats[i],
        ]
        keys = [norm]
        keys.extend(norm.split()[1:MAX_WORDS])
        for key in keys:
            prefix = key[:3]
            if not prefix or (prefix, qids[i]) in seen:
                continue
            seen.add((prefix, qids[i]))
            shards.setdefault(prefix, []).append(entry)
        if i and i % 500_000 == 0:
            print(f"  {i:,} items, {len(shards):,} shards")

    out_dir = config.DATA_DIR / "search"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    for level in (1, 2, 3):
        (out_dir / str(level)).mkdir(parents=True)

    # Level 3 shards are complete; levels 1 and 2 keep the best entries only,
    # which is what a one or two character query can usefully show anyway.
    #
    # Writes go through a thread pool: this produces tens of thousands of small
    # files, and if data/ sits on a network share the per-file round trip
    # dominates everything else (~18 files/s serially, versus a few hundred).
    def write_shard(args: tuple[Path, list]) -> int:
        path, entries = args
        path.write_text(
            json.dumps(entries, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        return len(entries)

    short: dict[int, dict[str, list]] = {1: {}, 2: {}}
    total_entries = 0
    jobs: list[tuple[Path, list]] = []
    for prefix, entries in shards.items():
        entries.sort(key=lambda e: -e[4])
        total_entries += len(entries)
        jobs.append((out_dir / "3" / shard_filename(prefix), entries))
        for level in (1, 2):
            bucket = short[level].setdefault(prefix[:level], [])
            bucket.extend(entries[:TOP_PER_SHORT_SHARD])

    for level, buckets in short.items():
        for prefix, entries in buckets.items():
            entries.sort(key=lambda e: -e[4])
            jobs.append(
                (out_dir / str(level) / shard_filename(prefix), entries[:TOP_PER_SHORT_SHARD])
            )

    written = 0
    with ThreadPoolExecutor(max_workers=32) as pool:
        for _ in pool.map(write_shard, jobs):
            written += 1
            if written % 5000 == 0:
                print(f"  wrote {written:,}/{len(jobs):,} shards")

    manifest = {
        "levels": [1, 2, 3],
        "prefixes": {
            "1": sorted(short[1]),
            "2": sorted(short[2]),
            "3": sorted(shards),
        },
        "entries": total_entries,
        "items": len(df),
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, separators=(",", ":")), encoding="utf-8"
    )
    print(
        f"wrote {len(shards):,} level-3 shards, {total_entries:,} entries "
        f"in {(time.perf_counter() - started) / 60:.1f} min"
    )


if __name__ == "__main__":
    main()
