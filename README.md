# Wikipedia importance map

Every geolocated Wikipedia article on a map, with label size driven by how
important the subject is. Importance combines two independent signals:
[danker](https://github.com/athalhammer/danker) PageRank over the link graph of
*all* Wikipedia language editions, and
[QRank](https://qrank.wmcloud.org/) pageviews.

The repository holds two things: a data pipeline that turns raw Wikimedia dumps
into map tiles, and a static site that reads them. There is no server and no
build step.

```
pipeline/   dumps -> articles.parquet -> tiles + search index
data/       pipeline output (gitignored)
src/        the site, as ES modules
index.html  the page
tests/      Python-encoder / JS-decoder round trip
```

## Running the site

The site is static, but it uses ES modules and `fetch`, so it needs to be
served rather than opened from disk:

```sh
python -m http.server 8000
# then open http://localhost:8000/
```

`data/` must contain `manifest.json`, `tiles/` and `search/` — see below.

## The data pipeline

### Inputs

Download these into one directory (default `G:\tt\wikidata`, override with
`WIKIMAP_DUMPS`):

| File | Size | Source |
|---|---|---|
| `latest-truthy.nt.bz2` | 43 GB | `dumps.wikimedia.org/wikidatawiki/entities/` |
| `<date>.allwiki.links.rank.bz2` | 226 MB | `danker.s3.amazonaws.com` |
| `qrank*.gz` | 109 MB | `qrank.wmcloud.org/download/qrank.csv.gz` |
| `wikidatawiki-latest-wb_items_per_site.sql.gz` | 1.9 GB | `dumps.wikimedia.org/wikidatawiki/latest/` |

The last one is needed because **the truthy dump contains no sitelinks** — it
has labels, descriptions and statements, but not the Wikipedia article titles.
Those come from Wikidata's `wb_items_per_site` table instead, which has the
title in every language edition, so it also supplies the "original" title and a
sitelink count.

### Stages

```sh
python -m pipeline.run_all            # everything, about an hour
python -m pipeline.run_all --list     # what the stages are
python -m pipeline.run_all --from master
```

Measured on a 256-core machine, writing to a network share:

1. **`extract_truthy`** (67 min) — streams the 43 GB dump, which is **990 GiB**
   of N-Triples. A single bzip2 stream cannot be split by byte offset, so one
   reader process decompresses with `indexed_bzip2` (which decodes bz2 blocks
   across all cores — 270 MB/s sustained, against 26 MB/s for stock `bz2`) and
   feeds line-aligned chunks to 16 parser processes over one queue each. Each
   parser scans with regexes anchored on distinctive predicate literals, so the
   ~97% of lines nobody wants are rejected inside the C matcher and never become
   Python objects. Output: 12,350,782 coordinates, 164,767,921 item claims,
   92,416,762 English labels, 102,203,884 descriptions.

2. **`extract_ranks`** (20 s) — danker (25,816,446 items) and QRank
   (28,880,307 items) to parquet keyed by Q-number.

3. **`extract_sitelinks`** (5 min) — 99,742,340 sitelinks from the MySQL dump.

4. **`build_master`** (11 min) — one DuckDB job producing 12,078,243 rows:
   86.3% with a usable name, 53.6% with an article in some language, 11.7% with
   an English one, 97.2% categorised.

5. **`build_tiles`** (5 min) — 98,742 tiles, 310 MB, mean 3.1 KiB per tile.

6. **`build_search`** — the prefix-sharded search index.

A caveat on the regexes, since it is the one thing that will bite anyone
editing them: the quoted-literal pattern is written as the unrolled
`[^"\\]*(?:\\.[^"\\]*)*`, not the obvious `(?:[^"\\]+|\\.)*`. The obvious form
is ambiguous, so every non-English label — most of a 990 GiB dump — backtracks
exponentially when the trailing `@en` test fails. That one change took the
parser from 1.8 MB/s to 74 MB/s per core.

### `articles.parquet`

One row per geolocated item, sorted by score. Columns:

| Group | Columns |
|---|---|
| identity | `qid`, `label_en`, `descr_en`, `title_en`, `title_native`, `native_site`, `native_label`, `native_lang`, `title_any`, `any_site` |
| location | `lon`, `lat`, `n_coords`, `country_qid`, `country_label`, `admin_qid`, `admin_label` |
| category | `cat`, `sub`, `instance_of` (list of class Q-ids) |
| importance | `pagerank`, `qrank`, `n_sitelinks`, `pr_norm`, `qr_norm`, `sl_norm`, `score`, `pr_pct`, `qr_pct` |
| extras | `population`, `elevation`, `inception`, `image`, `website` |

A quarter of geolocated items have no English label at all — many are bot
imports from national registries. 1.3M of those do have an article in some
other language (Cebuano, Chechen, Tatar, Serbian, Russian…), so `title_any`
keeps the best available title and the map shows a real name instead of
`Q12345`. Names are resolved as `label_en → title_en → native_label →
title_any`. The 1.65M items with no name anywhere stay in `articles.parquet`
but are left out of the tiles, since a tile is a list of labels.

Two notes on correctness, both of which are easy to get wrong:

* P625 serialises as `Point(lon lat)` — **longitude first**. Values on another
  globe carry a globe prefix (`"<.../Q308> Point(...)"`), so requiring the
  literal to start with `Point(` keeps the data on Earth.
* An item can have several P625 values. Averaging them would invent a location
  that is not in Wikidata, so `build_master` keeps the real value closest to the
  median and records how many there were in `n_coords`.

### Importance

Raw PageRank is dominated by countries, years and languages, so both signals
are log-compressed and normalised *within the geolocated subset*:

```
pr_norm = log10(1 + pagerank) / max(log10(1 + pagerank))
qr_norm = log10(1 + qrank)    / max(log10(1 + qrank))
score   = 0.45*pr_norm + 0.45*qr_norm + 0.10*sitelink_norm
```

Log rather than percentile, because a label map wants the heavy tail: Paris
really should dwarf a hamlet. Percentile ranks (`pr_pct`, `qr_pct`) are stored
too, for "show me the top 1%" style filtering.

### Categories

Wikidata has no "type of thing" field, just P31 pointing at tens of thousands
of classes. `pipeline/taxonomy.py` pins ~135 well-known classes to a
(category, subcategory) pair, then walks the P279 subclass graph — 5,212,393
edges — so every other class inherits from the nearest anchor. That covers
267,156 classes and categorises 97.2% of items. Anchors carry a priority, so an
item that is both a castle and a building comes out as a castle.

Run `--verify` after editing the anchors. Q-ids are easy to mistype and the
result is silently wrong rather than broken: the first draft of this list had
Q16560789 as "police station", when it is actually a person, and Q39594 as
"cliff", when it is "bay".

```sh
python -m pipeline.survey_classes --top 400   # which classes actually matter
python -m pipeline.taxonomy --verify          # check anchor ids against the dump
```

There are exactly **eight coloured categories** because that is where
categorical colour stops working. A map shows every category at once, so the
palette had to clear the all-pairs colour-vision gates, not the easier
adjacent-pairs ones. Detail lives in the subcategories, which are read as text
and are therefore free. Colour is never the only channel: the filter list, the
tooltip and the detail panel all name the category.

## Tile format

Standard slippy-map XYZ tiles at `data/tiles/{z}/{x}/{y}.bin.gz`, plus
`data/tiles/{z}/index.bin.gz` listing which tiles exist at that zoom.

Every item is written into **exactly one** tile: the shallowest zoom whose tile
still has room, taking items in importance order. Zoom 0 holds the few hundred
most important places on Earth, zoom 1 the next band, and so on. Drawing zoom Z
means unioning the tiles for z = 0..Z that cover the viewport.

Each tile has two budgets: a global one (`--capacity`, 200 items by score) and
a per-category one (`--cat-quota`, 8 items). Without the second, filtering to
"Museums" at world zoom would show nothing, because no museum outranks the top
few hundred cities.

The payload is columnar, little-endian, gzipped, with every array on a 4-byte
boundary so the decoder can make typed-array views without copying:

```
0   "WMT1", uint16 version, uint16 z
8   uint32 x, uint32 y, uint32 count
20  uint32 titleBytes, uint32 wikiBytes, uint32 reserved
32  qid u32[n], titleOff u32[n+1], wikiOff u32[n+1],
    lon f32[n], lat f32[n], score u16[n], pr u16[n], qr u16[n],
    cat u8[n], sub u8[n], flags u8[n], titles utf8, wikis utf8
```

`wiki` holds `lang|title` — the article to link to, preferring English. The
title part is left empty when it equals the drawn label, which is the common
case (Wikipedia titles cannot contain `|`, so it is a safe separator). `flags`
bit 0 means an article exists, bit 1 means Wikidata has an image.

## Tests

```sh
python -m tests.test_tile_format    # Python encoder -> JS decoder round trip
python -m tests.test_build_master   # the join's SQL, on synthetic shards
```

Both run in seconds and need no dumps. The first exists because the tile format
is written in one language and read in another; the second because the real join
takes ten minutes, so the fiddly parts (which coordinate wins, which category
wins, the fallback chain) are worth checking on six rows.

For the site itself, start a headless Chromium with
`--remote-debugging-port=9222` and run:

```sh
node tests/browser_check.mjs http://localhost:8000/ shot.png
node tests/interaction_check.mjs http://localhost:8000/
```

`browser_check` reports console errors, failed requests, how many tiles were
fetched and how many labels were drawn, and saves a screenshot.
`interaction_check` drives the real UI in 14 checks: the default category
selection, filtering a category off and back on, subcategory expansion, search,
flying to a result, the detail panel with its live Wikipedia summary and
thumbnail, the density slider, and all / none.

Order matters in that file. The default-selection check has to come first,
because later steps switch categories on deliberately — the slider step needs
them all on, or too few labels fit for the cap to bind and it would assert
nothing.

There is no Node on this machine's PATH; both scripts run under the Node bundled
inside VS Code (`ELECTRON_RUN_AS_NODE=1 "…/Code.exe" script.mjs`), and
`test_tile_format` finds it automatically.

## The site

| Module | Responsibility |
|---|---|
| `src/main.js` | wiring, view state, URL hash, controls |
| `src/tiles.js` | `TileManager` — what to load, caching, aborting, eviction |
| `src/decode.js` | the binary tile decoder |
| `src/declutter.js` | screen-space label selection |
| `src/layers.js` | deck.gl label and dot layers |
| `src/categories.js` | category/subcategory filter and panel |
| `src/search.js` | prefix search against the static shards |
| `src/ui.js` | tooltip and detail panel |

### Label decluttering

A viewport can hold 25,000 places and perhaps 300 readable names, so choosing
which names to draw is most of what makes the map legible.

deck.gl ships a `CollisionFilterExtension` for this, and the old version used
it. It is gone, because its behaviour depends on the renderer: on a software
rasteriser it culled 297 of 300 labels over central Paris, and a page cannot
detect that it happened. `declutter.js` does the same job in JS — walk
candidates in importance order, keep a label if its box does not touch a box
already kept, stop at the budget — which costs a few milliseconds and always
gives the same answer. It also reserves the panel rectangles, so no label is
drawn where a panel would cover it.

The selection is recomputed when the view settles (130 ms), not per frame:
labels are anchored to the map, so the set stays correct while panning, and
recomputing mid-drag would make them flicker.

### What the old version got wrong

* **"Sometimes data disappears."** The old code kept one tile per zoom in a slot
  that the next pan overwrote (`datalevel[l] = data`), and drew
  `datalevel.flat()`. Now every tile lives in an LRU cache and the map draws the
  union of all cached tiles covering the view.
* **"Sometimes too much data was loaded."** The old code refetched on every
  move, behind a 1-second debounce that also delayed drawing. Now a tile is
  fetched at most once, requests that scroll out of view are aborted, and the
  per-zoom index means a tile that does not exist is never requested. Redraw is
  decoupled from loading: a view change redraws immediately from cache and only
  *schedules* fetches, so the map never blanks while panning.
* **Coordinates.** The old tiles were addressed with a hand-rolled scheme over a
  longitude range of −353.07 to 360, and positions were stored negated
  (`-parseFloat(cols[2])`). Tiles are now plain Web Mercator XYZ.

### Interaction

Settlements and Administrative start unchecked. They are the two categories the
importance score favours hardest, so with them on the first view is city and
country names — which is what the basemap underneath already says. Both are one
click away in the filter list, and `DEFAULT_OFF` in `src/main.js` is the whole
of it.

Hover shows the name, category and importance. Clicking opens a panel that
fetches the Wikipedia summary and thumbnail for that one item from the REST
API, so nothing is paid for it while panning, with links to Wikipedia,
Wikidata, OpenStreetMap and Google Maps. The sliders re-weight PageRank against
pageviews, set a minimum importance and scale label size. The map position
lives in the URL hash, so a view can be shared.

### Known limits

* The pyramid is built from the fixed 45/45/10 score. The slider re-weights
  *label size* live, but not which items are in which tile.
* Category filtering only hides what the tiles already contain. The per-category
  quota keeps every category represented at every zoom, but a filtered view is
  not as dense as a dedicated per-category pyramid would be.
* The tile index is fetched for every zoom at startup (a few hundred KB).
