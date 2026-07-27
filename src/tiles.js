// Tile loading and caching.
//
// What went wrong in the old version, and how this fixes it:
//
//  * "sometimes data disappears" - the old code kept one tile per zoom level in
//    a slot that the next pan overwrote. Here every tile lives in an LRU cache
//    and what gets drawn is the union of all cached tiles covering the view.
//  * "sometimes too much data was loaded" - the old code refetched on every
//    move. Here a tile is fetched at most once, requests that scroll out of
//    view are aborted, and a per-zoom index means a tile that does not exist is
//    never requested at all.
//
// Because the pyramid puts every item in exactly one tile, drawing zoom Z means
// unioning tiles for z = 0..Z: parents stay cached while panning, and nothing
// is ever drawn twice.

import { fetchTile, fetchTileIndex } from "./decode.js";

const MAX_CONCURRENT = 10;
const MAX_CACHED_TILES = 1200;
const BOUNDS_PADDING = 0.1; // fraction of the viewport, so panning has a head start

export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * (1 << z));
}

export function latToTileY(lat, z) {
  const n = 1 << z;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  return Math.max(0, Math.min(n - 1, y));
}

export class TileManager {
  constructor({ baseUrl, manifest, onUpdate }) {
    this.baseUrl = baseUrl;
    this.maxZoom = manifest.maxZoom;
    this.onUpdate = onUpdate;
    // Which zooms the build actually produced, so a zoom with no tiles is
    // distinguishable from a zoom whose index failed to download.
    this.populatedZooms = new Set(
      Object.keys(manifest.zooms ?? {}).map((z) => Number(z))
    );
    this.cache = new Map();      // "z/x/y" -> {items, bytes, used}
    this.pending = new Map();    // "z/x/y" -> {controller}
    this.indexes = new Map();    // z -> Set of packed (x<<16|y)
    this.needed = [];            // ordered list of keys currently in view
    this.queue = [];
    this.clock = 0;
    this.loadedBytes = 0;
    this.requests = 0;
  }

  /** Indexes are tiny and there are only a dozen; fetching them up front makes
   *  every later existence check synchronous. */
  async loadIndexes() {
    const zooms = [];
    for (let z = 0; z <= this.maxZoom; z++) zooms.push(z);
    await Promise.all(
      zooms.map(async (z) => {
        const set = await fetchTileIndex(`${this.baseUrl}/tiles/${z}/index.bin.gz`).catch(
          () => null
        );
        if (set) this.indexes.set(z, set);
      })
    );
  }

  exists(z, x, y) {
    const index = this.indexes.get(z);
    if (index) return index.has(((x << 16) | y) >>> 0);
    // No index in hand: if the build says this zoom has tiles, try anyway and
    // let the 404 handling sort it out. Better a few wasted requests than a
    // blank map because one small file did not download.
    return this.populatedZooms.has(z);
  }

  /** Every tile covering the viewport, from the world tile down to the current
   *  zoom, nearest-to-centre first. */
  tilesForView(bounds, zoom) {
    const [minX, minY, maxX, maxY] = bounds;
    const padX = (maxX - minX) * BOUNDS_PADDING;
    const padY = (maxY - minY) * BOUNDS_PADDING;
    const west = minX - padX, east = maxX + padX;
    const south = minY - padY, north = maxY + padY;
    const centreX = (minX + maxX) / 2, centreY = (minY + maxY) / 2;

    const zMax = Math.min(Math.max(Math.floor(zoom), 0), this.maxZoom);
    const wanted = [];
    for (let z = 0; z <= zMax; z++) {
      const n = 1 << z;
      const yTop = latToTileY(north, z);
      const yBottom = latToTileY(south, z);
      let xLeft = lonToTileX(west, z);
      let xRight = lonToTileX(east, z);
      if (xRight - xLeft + 1 >= n) { xLeft = 0; xRight = n - 1; } // whole world in view
      const cx = lonToTileX(centreX, z), cy = latToTileY(centreY, z);
      for (let x = xLeft; x <= xRight; x++) {
        const wrapped = ((x % n) + n) % n; // antimeridian
        for (let y = yTop; y <= yBottom; y++) {
          if (!this.exists(z, wrapped, y)) continue;
          wanted.push({
            z, x: wrapped, y,
            key: `${z}/${wrapped}/${y}`,
            dist: Math.abs(x - cx) + Math.abs(y - cy),
          });
        }
      }
    }
    return wanted;
  }

  /** Reconcile the in-flight/queued work with what the current view needs. */
  update(bounds, zoom) {
    const wanted = this.tilesForView(bounds, zoom);
    const wantedKeys = new Set(wanted.map((t) => t.key));
    this.needed = wanted.map((t) => t.key);

    for (const [key, entry] of this.pending) {
      if (!wantedKeys.has(key)) {
        entry.controller.abort();
        this.pending.delete(key);
      }
    }

    // Shallow tiles first: they carry the important labels and cover the most
    // ground, so the map fills in from the top down.
    this.queue = wanted
      .filter((t) => !this.cache.has(t.key) && !this.pending.has(t.key))
      .sort((a, b) => a.z - b.z || a.dist - b.dist);

    this.pump();
    this.evict(wantedKeys);
  }

  pump() {
    while (this.pending.size < MAX_CONCURRENT && this.queue.length) {
      const tile = this.queue.shift();
      const controller = new AbortController();
      this.pending.set(tile.key, { controller });
      this.requests += 1;
      fetchTile(
        `${this.baseUrl}/tiles/${tile.z}/${tile.x}/${tile.y}.bin.gz`,
        controller.signal
      )
        .then((decoded) => {
          this.pending.delete(tile.key);
          this.cache.set(tile.key, {
            items: decoded ? decoded.items : [],
            bytes: decoded ? decoded.bytes : 0,
            used: ++this.clock,
          });
          this.loadedBytes += decoded ? decoded.bytes : 0;
          this.pump();
          this.onUpdate?.();
        })
        .catch((err) => {
          this.pending.delete(tile.key);
          if (err.name !== "AbortError") {
            console.warn("tile failed", tile.key, err);
            this.cache.set(tile.key, { items: [], bytes: 0, used: ++this.clock });
          }
          this.pump();
        });
    }
  }

  evict(keep) {
    if (this.cache.size <= MAX_CACHED_TILES) return;
    const victims = [...this.cache.entries()]
      .filter(([key]) => !keep.has(key))
      .sort((a, b) => a[1].used - b[1].used);
    let excess = this.cache.size - MAX_CACHED_TILES;
    for (const [key] of victims) {
      if (excess-- <= 0) break;
      this.cache.delete(key);
    }
  }

  /** Everything currently in view that has arrived. Missing tiles simply are
   *  not there yet - they never blank out what is already drawn. */
  visibleItems() {
    const out = [];
    for (const key of this.needed) {
      const tile = this.cache.get(key);
      if (!tile) continue;
      tile.used = ++this.clock;
      for (const item of tile.items) out.push(item);
    }
    return out;
  }

  stats() {
    return {
      cached: this.cache.size,
      pending: this.pending.size,
      queued: this.queue.length,
      needed: this.needed.length,
      megabytes: this.loadedBytes / 1e6,
      requests: this.requests,
    };
  }
}
