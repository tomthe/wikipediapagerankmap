"""Run build_master's SQL against tiny synthetic shards.

The real join takes minutes on hundreds of millions of rows, so this builds a
handful of rows with the same schemas and checks the parts that are easy to get
wrong: picking one coordinate out of several, the label/title fallbacks, the
native-language title, the category priority rule, and the score maths.

    python -m tests.test_build_master
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import polars as pl

REPO = Path(__file__).resolve().parent.parent

# qid 1 London: two coordinates, enwiki article, a capital and a city
# qid 2 München: native label + dewiki title, no enwiki article
# qid 3 a nameless thing with no rank at all
# qid 4 a castle that is also a building - priority must pick castle
COORDS = [
    (1, -0.1276, 51.5072),
    (1, -0.1280, 51.5080),
    (1, -0.1278, 51.5076),
    (2, 11.5820, 48.1351),
    (3, 100.0, 13.0),
    (4, 8.0, 47.0),
]
CLAIMS_ITEM = [
    (1, 31, 5119), (1, 31, 515), (1, 17, 145),   # capital, city, country=UK
    (2, 31, 515), (2, 17, 183),                  # city, country=Germany
    (3, 31, 99999999),                           # unmapped class
    (4, 31, 23413), (4, 31, 41176),              # castle + building
    (23413, 279, 41176),                         # castle subclass of building
]
LABELS = [
    (1, "London"), (2, "Munich"), (4, "Neuschwanstein"),
    (145, "United Kingdom"), (183, "Germany"),
    (515, "city"), (5119, "capital"), (23413, "castle"), (41176, "building"),
]
SITELINKS = [
    (1, "enwiki", "London"), (1, "dewiki", "London"), (1, "frwiki", "Londres"),
    (1, "commonswiki", "Category:London"),   # must not count as a language edition
    (2, "dewiki", "München"), (2, "frwiki", "Munich"),
    (4, "enwiki", "Neuschwanstein Castle"),
]


def write(work: Path) -> None:
    truthy = work / "truthy"
    ranks = work / "ranks"
    sites = work / "sitelinks"
    for d in (truthy, ranks, sites):
        d.mkdir(parents=True, exist_ok=True)

    pl.DataFrame(
        COORDS, schema={"qid": pl.UInt32, "lon": pl.Float64, "lat": pl.Float64},
        orient="row",
    ).write_parquet(truthy / "coords_00.parquet")

    pl.DataFrame(
        CLAIMS_ITEM, schema={"qid": pl.UInt32, "pid": pl.UInt32, "value": pl.UInt32},
        orient="row",
    ).write_parquet(truthy / "claims_item_00.parquet")

    pl.DataFrame(
        [(1, 1082, 8900000.0), (2, 1082, 1500000.0), (4, 2044, 800.0)],
        schema={"qid": pl.UInt32, "pid": pl.UInt32, "value": pl.Float64},
        orient="row",
    ).write_parquet(truthy / "claims_num_00.parquet")

    pl.DataFrame(
        [(4, 571, "1869-01-01T00:00:00Z")],
        schema={"qid": pl.UInt32, "pid": pl.UInt32, "value": pl.String},
        orient="row",
    ).write_parquet(truthy / "claims_time_00.parquet")

    pl.DataFrame(
        [(1, 856, "https://london.gov.uk"), (4, 18, "http://commons/x.jpg")],
        schema={"qid": pl.UInt32, "pid": pl.UInt32, "value": pl.String},
        orient="row",
    ).write_parquet(truthy / "claims_iri_00.parquet")

    pl.DataFrame(
        [(2, 1705, "München", "de")],
        schema={
            "qid": pl.UInt32, "pid": pl.UInt32, "value": pl.String, "lang": pl.String
        },
        orient="row",
    ).write_parquet(truthy / "claims_mono_00.parquet")

    pl.DataFrame(
        [(183, 424, "de")],
        schema={"qid": pl.UInt32, "pid": pl.UInt32, "value": pl.String},
        orient="row",
    ).write_parquet(truthy / "claims_str_00.parquet")

    pl.DataFrame(
        LABELS, schema={"qid": pl.UInt32, "label": pl.String}, orient="row"
    ).write_parquet(truthy / "labels_en_00.parquet")

    pl.DataFrame(
        [(1, "Capital of England"), (2, "City in Bavaria")],
        schema={"qid": pl.UInt32, "descr": pl.String}, orient="row",
    ).write_parquet(truthy / "descr_en_00.parquet")

    pl.DataFrame(
        [(1, 1000.0), (2, 500.0), (4, 20.0)],
        schema={"qid": pl.UInt32, "pagerank": pl.Float64}, orient="row",
    ).write_parquet(ranks / "pagerank.parquet")

    pl.DataFrame(
        [(1, 900000), (2, 400000), (4, 5000)],
        schema={"qid": pl.UInt32, "qrank": pl.Int64}, orient="row",
    ).write_parquet(ranks / "qrank.parquet")

    pl.DataFrame(
        SITELINKS, schema={"qid": pl.UInt32, "site": pl.String, "title": pl.String},
        orient="row",
    ).write_parquet(sites / "sitelinks.parquet")


def main() -> None:
    failures: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "work"
        write(work)
        env = dict(os.environ, WIKIMAP_WORK=str(work), PYTHONIOENCODING="utf-8")
        proc = subprocess.run(
            [sys.executable, "-m", "pipeline.build_master"],
            capture_output=True, text=True, encoding="utf-8", env=env, cwd=REPO,
        )
        if proc.returncode != 0:
            print(proc.stdout[-3000:])
            print(proc.stderr[-3000:])
            sys.exit("build_master failed")

        df = pl.read_parquet(work / "articles.parquet")
        rows = {r["qid"]: r for r in df.to_dicts()}

        def check(name: str, ok: bool, detail: str = "") -> None:
            print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else '  ' + detail}")
            if not ok:
                failures.append(name)

        check("one row per item", len(df) == 4, f"got {len(df)}")

        london = rows[1]
        check("multi-coordinate item keeps a real value",
              (london["lon"], london["lat"]) in [(c[1], c[2]) for c in COORDS if c[0] == 1],
              str((london["lon"], london["lat"])))
        check("n_coords counts the duplicates", london["n_coords"] == 3,
              str(london["n_coords"]))
        check("english title from enwiki", london["title_en"] == "London")
        check("country label resolved", london["country_label"] == "United Kingdom",
              str(london["country_label"]))
        check("commonswiki excluded from sitelink count", london["n_sitelinks"] == 3,
              str(london["n_sitelinks"]))
        check("capital beats city on priority", london["sub"] == 1,
              f"cat={london['cat']} sub={london['sub']}")
        check("description carried through",
              london["descr_en"] == "Capital of England")
        check("population carried through", london["population"] == 8900000.0)

        munich = rows[2]
        check("native label kept", munich["native_label"] == "München",
              str(munich["native_label"]))
        check("native title from the matching wiki", munich["title_native"] == "München",
              str(munich["title_native"]))
        check("no enwiki article stays null", munich["title_en"] is None,
              str(munich["title_en"]))

        nameless = rows[3]
        check("item with no rank scores zero", nameless["score"] == 0.0,
              str(nameless["score"]))
        check("unmapped class falls back to Other", nameless["cat"] == 0,
              str(nameless["cat"]))

        castle = rows[4]
        check("castle beats building on priority",
              castle["cat"] == 5 and castle["sub"] > 0,
              f"cat={castle['cat']} sub={castle['sub']}")

        check("top item scores highest",
              london["score"] == max(r["score"] for r in rows.values()),
              str(london["score"]))
        check("normalised signals are in range",
              all(0.0 <= (r["pr_norm"] or 0) <= 1.0 for r in rows.values()))

    if failures:
        sys.exit(f"\n{len(failures)} check(s) failed: {', '.join(failures)}")
    print("\nbuild_master behaves")


if __name__ == "__main__":
    main()
