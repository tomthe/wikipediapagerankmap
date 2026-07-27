"""Write a small synthetic articles.parquet so the tile/search/site path can be
exercised without waiting an hour for the real extraction.

    WIKIMAP_WORK=<tmpdir> python -m tests.make_fake_master
    WIKIMAP_WORK=<tmpdir> python -m pipeline.build_tiles --max-zoom 9
    WIKIMAP_WORK=<tmpdir> python -m pipeline.build_search --min-score 0.2

Note that build_tiles and build_search write into the repository's data/
directory whatever WIKIMAP_WORK says, so this replaces the real map.

It has to produce every column build_tiles and build_search read, including the
ones that are usually null - an item with no population, no founding date and
no description is the common case, and the encoder's sentinel paths only get
exercised if the fixture contains some.
"""

from __future__ import annotations

import numpy as np
import polars as pl

from pipeline import config
from pipeline.taxonomy import CATEGORIES, subcategory_names

CITIES = [
    ("London", -0.1276, 51.5072, "United Kingdom", "Greater London"),
    ("Paris", 2.3522, 48.8566, "France", "Île-de-France"),
    ("Berlin", 13.405, 52.52, "Germany", "Berlin"),
    ("New York", -74.006, 40.7128, "United States", "New York"),
    ("Tokyo", 139.6917, 35.6895, "Japan", "Kantō"),
    ("Rostock", 12.0991, 54.0924, "Germany", "Mecklenburg-Vorpommern"),
    ("Cairo", 31.2357, 30.0444, "Egypt", "Cairo Governorate"),
    ("São Paulo", -46.6333, -23.5505, "Brazil", "São Paulo"),
    ("Sydney", 151.2093, -33.8688, "Australia", "New South Wales"),
    ("Reykjavík", -21.9426, 64.1466, "Iceland", "Capital Region"),
]
N_PER_CITY = 2500
N_SCATTER = 8000


def main() -> None:
    rng = np.random.default_rng(20260727)
    lons, lats, names, countries, admins = [], [], [], [], []

    for name, lon, lat, country, admin in CITIES:
        lons.append(lon)
        lats.append(lat)
        names.append(name)
        countries.append(country)
        admins.append(admin)
        spread = 0.35
        lons.extend(lon + rng.normal(0, spread, N_PER_CITY))
        lats.extend(lat + rng.normal(0, spread * 0.6, N_PER_CITY))
        names.extend(f"{name} place {j}" for j in range(N_PER_CITY))
        countries.extend([country] * N_PER_CITY)
        admins.extend([admin] * N_PER_CITY)

    lons.extend(rng.uniform(-180, 180, N_SCATTER))
    lats.extend(rng.uniform(-60, 70, N_SCATTER))
    names.extend(f"Remote thing {j}" for j in range(N_SCATTER))
    countries.extend([None] * N_SCATTER)
    admins.extend([None] * N_SCATTER)

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
    has_pop = rng.random(n) < 0.15
    has_elev = rng.random(n) < 0.25
    has_year = rng.random(n) < 0.2
    has_descr = rng.random(n) < 0.8

    def maybe(mask, values):
        return [v if m else None for m, v in zip(mask, values)]

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
            "title_native": names,
            "native_site": ["dewiki"] * n,
            "title_any": names,
            "any_site": ["enwiki" if a else "cebwiki" for a in has_article],
            "descr_en": maybe(has_descr, [f"a synthetic {CATEGORIES[c]} item" for c in cat]),
            # Wikidata stores these as doubles and an ISO timestamp string, and
            # both come through with nulls far more often than values.
            "population": maybe(has_pop, rng.integers(20, 9_000_000, n).astype(float)),
            "elevation": maybe(has_elev, rng.integers(-400, 6000, n).astype(float)),
            "inception": maybe(
                has_year,
                [f"{y:04d}-01-01T00:00:00Z" for y in rng.integers(800, 2020, n)],
            ),
            "n_sitelinks": rng.integers(0, 300, n).astype(np.int64),
            "country_label": countries,
            "admin_label": admins,
            # A tenth of them span several countries, so the "blank rather than
            # arbitrary" rule in build_tiles gets exercised.
            "n_countries": np.where(rng.random(n) < 0.1, 4, 1).astype(np.int64),
            "n_admin": np.ones(n, dtype=np.int64),
            "image": [
                "http://commons.wikimedia.org/x.jpg" if v else None
                for v in rng.random(n) < 0.3
            ],
            "website": ["https://example.org" if v else None for v in rng.random(n) < 0.1],
        }
    ).sort("score", descending=True)

    config.MASTER_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(config.MASTER_PARQUET, compression="zstd")
    print(f"wrote {config.MASTER_PARQUET}: {len(df):,} synthetic items")


if __name__ == "__main__":
    main()
