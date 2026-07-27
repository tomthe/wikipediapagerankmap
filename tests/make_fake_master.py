"""Write a small synthetic articles.parquet so the tile/search/site path can be
exercised without waiting an hour for the real extraction.

    WIKIMAP_WORK=<tmpdir> python -m tests.make_fake_master

Then point build_tiles and build_search at the same WIKIMAP_WORK.
"""

from __future__ import annotations

import numpy as np
import polars as pl

from pipeline import config
from pipeline.taxonomy import CATEGORIES, subcategory_names

CITIES = [
    ("London", -0.1276, 51.5072),
    ("Paris", 2.3522, 48.8566),
    ("Berlin", 13.405, 52.52),
    ("New York", -74.006, 40.7128),
    ("Tokyo", 139.6917, 35.6895),
    ("Rostock", 12.0991, 54.0924),
    ("Cairo", 31.2357, 30.0444),
    ("São Paulo", -46.6333, -23.5505),
    ("Sydney", 151.2093, -33.8688),
    ("Reykjavík", -21.9426, 64.1466),
]
N_PER_CITY = 2500
N_SCATTER = 8000


def main() -> None:
    rng = np.random.default_rng(20260727)
    lons, lats, names = [], [], []

    for i, (name, lon, lat) in enumerate(CITIES):
        lons.append(lon)
        lats.append(lat)
        names.append(name)
        spread = 0.35
        lons.extend(lon + rng.normal(0, spread, N_PER_CITY))
        lats.extend(lat + rng.normal(0, spread * 0.6, N_PER_CITY))
        names.extend(f"{name} place {j}" for j in range(N_PER_CITY))

    lons.extend(rng.uniform(-180, 180, N_SCATTER))
    lats.extend(rng.uniform(-60, 70, N_SCATTER))
    names.extend(f"Remote thing {j}" for j in range(N_SCATTER))

    n = len(lons)
    subs = subcategory_names()
    cat = rng.integers(0, len(CATEGORIES), n)
    sub = np.array([rng.integers(0, len(subs[CATEGORIES[c]])) for c in cat])

    # Heavy-tailed importance, plus a guaranteed high score for the real cities
    # so they land in the shallow tiles.
    pr = rng.power(0.35, n)
    qr = rng.power(0.35, n)
    for i in range(len(CITIES)):
        idx = i * (N_PER_CITY + 1)
        pr[idx] = 0.93 + 0.06 * rng.random()
        qr[idx] = 0.93 + 0.06 * rng.random()

    score = 0.45 * pr + 0.45 * qr + 0.10 * rng.random(n)
    has_article = rng.random(n) < 0.6

    df = pl.DataFrame(
        {
            "qid": np.arange(1, n + 1, dtype=np.uint32),
            "lon": np.asarray(lons, dtype=np.float64),
            "lat": np.asarray(lats, dtype=np.float64),
            "score": score,
            "pr_norm": pr,
            "qr_norm": qr,
            "cat": cat.astype(np.uint8),
            "sub": sub.astype(np.uint8),
            "label_en": names,
            "title_en": [
                f"{nm} (disambig)" if a and i % 7 == 0 else (nm if a else None)
                for i, (nm, a) in enumerate(zip(names, has_article))
            ],
            "native_label": names,
            "image": [
                "http://commons.wikimedia.org/x.jpg" if v else None
                for v in rng.random(n) < 0.3
            ],
        }
    ).sort("score", descending=True)

    config.MASTER_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(config.MASTER_PARQUET, compression="zstd")
    print(f"wrote {config.MASTER_PARQUET}: {len(df):,} synthetic items")


if __name__ == "__main__":
    main()
