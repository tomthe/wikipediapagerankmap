"""Stage 5 - turn articles.parquet into a tile pyramid the browser can stream.

Pyramid
-------
Standard slippy-map XYZ tiles. Every item is written into exactly ONE tile:
the shallowest zoom whose tile still has room, taking items in importance
order. So zoom 0 holds the few hundred most important places on Earth, zoom 1
the next band, and so on.

That single property is what fixes the two old bugs. Rendering zoom Z means
loading the tiles for z = 0..Z that intersect the viewport and drawing their
union - parent tiles stay in cache while panning, nothing is ever loaded
twice, and nothing vanishes because a tile was replaced.

Format
------
One little-endian binary file per tile, gzipped, laid out as columns so the
browser can hand the arrays straight to deck.gl without touching each row:

  offset 0   magic "WMT1", uint16 version, uint16 z
         8   uint32 x, uint32 y, uint32 count
        20   uint32 titleBytes, uint32 wikiBytes, uint32 reserved
        32   qid Uint32[n], titleOff Uint32[n+1], wikiOff Uint32[n+1],
             lon Float32[n], lat Float32[n],
             score Uint16[n], pr Uint16[n], qr Uint16[n],
             cat Uint8[n], sub Uint8[n], flags Uint8[n],
             titles UTF-8, wikis UTF-8

Every array starts on a 4-byte boundary so the decoder can create typed array
views directly on the buffer. `wiki` holds the English Wikipedia title only
when it differs from the displayed label, which gzip then squashes to almost
nothing.

Usage:
    python -m pipeline.build_tiles [--max-zoom 12] [--capacity 250]
"""

from __future__ import annotations

import argparse
import functools
import gzip
import json
import math
import shutil
import struct
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import polars as pl

from pipeline import config
from pipeline.taxonomy import CATEGORIES, PALETTE, subcategory_names

MAGIC = b"WMT1"
VERSION = 1
HEADER_BYTES = 32
FLAG_HAS_WIKI = 1
FLAG_HAS_IMAGE = 2

print = functools.partial(print, flush=True)


def tile_xy(lon: np.ndarray, lat: np.ndarray, z: int) -> tuple[np.ndarray, np.ndarray]:
    """Web-Mercator tile indices, clamped to the mercator latitude limits."""
    n = 1 << z
    x = np.floor((lon + 180.0) / 360.0 * n).astype(np.int64)
    clamped = np.clip(lat, -85.05112878, 85.05112878)
    sin_lat = np.sin(np.radians(clamped))
    y = np.floor(
        (0.5 - np.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)) * n
    ).astype(np.int64)
    return np.clip(x, 0, n - 1), np.clip(y, 0, n - 1)


def assign_zoom(
    df: pl.DataFrame, max_zoom: int, capacity: int, cat_quota: int
) -> pl.DataFrame:
    """Give every row the shallowest zoom whose tile still has room.

    Processing zoom by zoom is equivalent to walking the items one at a time
    in score order and pushing each down until it fits, but it stays vectorised.

    Each tile has two ways in: the global budget (`capacity` items by score)
    and a per-category budget (`cat_quota` items per category). Without the
    second one, filtering the map to "Museums" at world zoom would show
    nothing at all, because no museum outranks the top few hundred cities.
    """
    df = df.sort("score", descending=True)
    placed: list[pl.DataFrame] = []
    remaining = df
    for z in range(max_zoom + 1):
        if remaining.is_empty():
            break
        lon = remaining["lon"].to_numpy()
        lat = remaining["lat"].to_numpy()
        tx, ty = tile_xy(lon, lat, z)
        remaining = remaining.with_columns(
            pl.Series("tx", tx, dtype=pl.Int64),
            pl.Series("ty", ty, dtype=pl.Int64),
        ).with_columns(
            pl.int_range(pl.len()).over(["tx", "ty"]).alias("slot"),
            pl.int_range(pl.len()).over(["tx", "ty", "cat"]).alias("cat_slot"),
        )
        if z == max_zoom:
            # Deepest level takes whatever is left, so nothing is dropped.
            fits = remaining
            rest = remaining.clear()
        else:
            keep = (pl.col("slot") < capacity) | (pl.col("cat_slot") < cat_quota)
            fits = remaining.filter(keep)
            rest = remaining.filter(~keep)
        placed.append(fits.with_columns(pl.lit(z, dtype=pl.UInt8).alias("z")))
        print(
            f"  z={z:2d}  {len(fits):9,d} items  "
            f"{fits.select(pl.struct('tx', 'ty').n_unique()).item():7,d} tiles  "
            f"{len(rest):9,d} left"
        )
        remaining = rest.drop("slot", "cat_slot")
    return pl.concat(placed)


def encode_tile(rows: dict[str, np.ndarray], z: int, x: int, y: int) -> bytes:
    n = len(rows["qid"])
    titles = rows["title"]
    wikis = rows["wiki"]

    title_blob = bytearray()
    title_off = np.zeros(n + 1, dtype=np.uint32)
    for i, s in enumerate(titles):
        title_blob += s.encode("utf-8")
        title_off[i + 1] = len(title_blob)
    wiki_blob = bytearray()
    wiki_off = np.zeros(n + 1, dtype=np.uint32)
    for i, s in enumerate(wikis):
        wiki_blob += s.encode("utf-8")
        wiki_off[i + 1] = len(wiki_blob)

    parts: list[bytes] = [
        struct.pack(
            "<4sHHIIIIII",
            MAGIC,
            VERSION,
            z,
            x,
            y,
            n,
            len(title_blob),
            len(wiki_blob),
            0,
        )
    ]
    parts.append(rows["qid"].astype("<u4").tobytes())
    parts.append(title_off.astype("<u4").tobytes())
    parts.append(wiki_off.astype("<u4").tobytes())
    parts.append(rows["lon"].astype("<f4").tobytes())
    parts.append(rows["lat"].astype("<f4").tobytes())
    parts.append(rows["score"].astype("<u2").tobytes())
    parts.append(rows["pr"].astype("<u2").tobytes())
    parts.append(rows["qr"].astype("<u2").tobytes())
    pad = (-6 * n) % 4
    if pad:
        parts.append(b"\0" * pad)
    parts.append(rows["cat"].astype("u1").tobytes())
    parts.append(rows["sub"].astype("u1").tobytes())
    parts.append(rows["flags"].astype("u1").tobytes())
    pad = (-3 * n) % 4
    if pad:
        parts.append(b"\0" * pad)
    parts.append(bytes(title_blob))
    parts.append(bytes(wiki_blob))
    return b"".join(parts)


def _write_group(args) -> tuple[int, int, int, int]:
    z, x, y, payload, out_dir = args
    path = Path(out_dir) / str(z) / str(x)
    path.mkdir(parents=True, exist_ok=True)
    blob = gzip.compress(payload, 6, mtime=0)
    (path / f"{y}.bin.gz").write_bytes(blob)
    return z, x, y, len(blob)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-zoom", type=int, default=12)
    ap.add_argument("--capacity", type=int, default=200)
    ap.add_argument("--cat-quota", type=int, default=8)
    ap.add_argument("--workers", type=int, default=24)
    args = ap.parse_args()

    started = time.perf_counter()
    print(f"reading {config.MASTER_PARQUET}")
    master = pl.read_parquet(
        config.MASTER_PARQUET,
        columns=[
            "qid", "lon", "lat", "score", "pr_norm", "qr_norm",
            "cat", "sub", "label_en", "title_en", "native_label",
            "title_native", "native_site", "title_any", "any_site", "image",
        ],
    )
    print(f"  {len(master):,} items")

    # A tile is a list of labels; an item with no name anywhere would draw as
    # "Q12345", which is noise. Those rows stay in articles.parquet.
    before = len(master)
    master = master.filter(
        pl.any_horizontal(
            pl.col("label_en").is_not_null(),
            pl.col("title_en").is_not_null(),
            pl.col("native_label").is_not_null(),
            pl.col("title_any").is_not_null(),
        )
    )
    print(f"  {before - len(master):,} unnamed items skipped, {len(master):,} to place")

    df = master.select(
        pl.col("qid").cast(pl.UInt32),
        pl.col("lon").cast(pl.Float64),
        pl.col("lat").cast(pl.Float64),
        pl.col("score").cast(pl.Float64),
        (pl.col("pr_norm").fill_null(0.0) * 65535).clip(0, 65535).cast(pl.UInt16).alias("pr"),
        (pl.col("qr_norm").fill_null(0.0) * 65535).clip(0, 65535).cast(pl.UInt16).alias("qr"),
        pl.col("cat").cast(pl.UInt8),
        pl.col("sub").cast(pl.UInt8),
        # Drawn label: English label, else the English article title, else the
        # name the place uses itself, else whatever article exists.
        pl.coalesce(
            pl.col("label_en"),
            pl.col("title_en"),
            pl.col("native_label"),
            pl.col("title_any"),
        ).alias("title"),
        pl.col("title_en"),
        # Article to link to, preferring English.
        pl.coalesce(pl.col("title_en"), pl.col("title_any")).alias("article"),
        pl.when(pl.col("title_en").is_not_null())
        .then(pl.lit("enwiki"))
        .otherwise(pl.col("any_site"))
        .alias("article_site"),
        pl.col("image"),
    ).with_columns(
        # "lang|title", with the title left empty when it equals the drawn
        # label - by far the common case, and gzip squashes the rest. Wikipedia
        # titles cannot contain "|", so it is a safe separator.
        pl.when(pl.col("article").is_null())
        .then(pl.lit(""))
        .otherwise(
            pl.format(
                "{}|{}",
                pl.col("article_site").str.strip_suffix("wiki").str.replace_all("_", "-"),
                pl.when(pl.col("article") == pl.col("title"))
                .then(pl.lit(""))
                .otherwise(pl.col("article")),
            )
        )
        .alias("wiki"),
        (
            pl.when(pl.col("article").is_not_null()).then(FLAG_HAS_WIKI).otherwise(0)
            + pl.when(pl.col("image").is_not_null()).then(FLAG_HAS_IMAGE).otherwise(0)
        ).cast(pl.UInt8).alias("flags"),
    ).drop("title_en", "article", "article_site", "image")

    print("assigning zoom levels")
    df = assign_zoom(df, args.max_zoom, args.capacity, args.cat_quota)
    df = df.with_columns(
        (pl.col("score") * 65535).clip(0, 65535).cast(pl.UInt16).alias("score_u16")
    )

    out_dir = config.DATA_DIR / "tiles"
    if out_dir.exists():
        print(f"clearing {out_dir}")
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    print("encoding tiles")
    jobs = []
    for (z, x, y), group in df.group_by(["z", "tx", "ty"], maintain_order=False):
        rows = {
            "qid": group["qid"].to_numpy(),
            "lon": group["lon"].to_numpy(),
            "lat": group["lat"].to_numpy(),
            "score": group["score_u16"].to_numpy(),
            "pr": group["pr"].to_numpy(),
            "qr": group["qr"].to_numpy(),
            "cat": group["cat"].to_numpy(),
            "sub": group["sub"].to_numpy(),
            "flags": group["flags"].to_numpy(),
            "title": group["title"].to_list(),
            "wiki": group["wiki"].to_list(),
        }
        jobs.append((int(z), int(x), int(y), encode_tile(rows, int(z), int(x), int(y)), str(out_dir)))
    print(f"  {len(jobs):,} tiles to write")

    index: dict[int, list[int]] = {}
    total_bytes = 0
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for z, x, y, size in pool.map(_write_group, jobs, chunksize=64):
            index.setdefault(z, []).append((x << 16) | y)
            total_bytes += size

    # Per-zoom index of which tiles exist, so the client never requests a 404.
    for z, keys in index.items():
        arr = np.array(sorted(keys), dtype="<u4")
        (out_dir / str(z) / "index.bin.gz").write_bytes(
            gzip.compress(arr.tobytes(), 6, mtime=0)
        )

    subs = subcategory_names()
    manifest = {
        "version": VERSION,
        "format": "WMT1",
        "maxZoom": args.max_zoom,
        "capacity": args.capacity,
        "tileCount": len(jobs),
        "itemCount": len(df),
        "totalBytes": total_bytes,
        "categories": [
            {"id": i, "name": name, "subcategories": subs.get(name, ["Other"])}
            for i, name in enumerate(CATEGORIES)
        ],
        "palette": PALETTE,
        "zooms": {str(z): len(keys) for z, keys in sorted(index.items())},
    }
    (config.DATA_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )

    print(f"\nwrote {len(jobs):,} tiles, {total_bytes / 1e6:.0f} MB total")
    print(f"  mean tile {total_bytes / max(len(jobs), 1) / 1024:.1f} KiB")
    print(f"  {(time.perf_counter() - started) / 60:.1f} min")


if __name__ == "__main__":
    main()
