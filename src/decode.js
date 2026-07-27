// Binary tile decoder for the WMT1 format written by pipeline/build_tiles.py.
//
// Layout (little-endian, every array 4-byte aligned so the views below are
// zero-copy):
//   0   "WMT1", uint16 version, uint16 z
//   8   uint32 x, uint32 y, uint32 count
//   20  uint32 titleBytes, uint32 wikiBytes, uint32 reserved
//   32  qid u32[n], titleOff u32[n+1], wikiOff u32[n+1],
//       lon f32[n], lat f32[n], score u16[n], pr u16[n], qr u16[n],
//       cat u8[n], sub u8[n], flags u8[n], titles utf8, wikis utf8

const MAGIC = 0x31544d57; // "WMT1" read as a little-endian uint32
const FLAG_HAS_WIKI = 1;
const FLAG_HAS_IMAGE = 2;

const decoder = new TextDecoder("utf-8");

/** Gunzip unless the host already did it via Content-Encoding. */
async function maybeGunzip(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) return buffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

export function decodeTile(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("not a WMT1 tile");

  const z = view.getUint16(6, true);
  const x = view.getUint32(8, true);
  const y = view.getUint32(12, true);
  const n = view.getUint32(16, true);
  const titleBytes = view.getUint32(20, true);
  const wikiBytes = view.getUint32(24, true);

  let o = 32;
  const qid = new Uint32Array(buffer, o, n); o += 4 * n;
  const titleOff = new Uint32Array(buffer, o, n + 1); o += 4 * (n + 1);
  const wikiOff = new Uint32Array(buffer, o, n + 1); o += 4 * (n + 1);
  const lon = new Float32Array(buffer, o, n); o += 4 * n;
  const lat = new Float32Array(buffer, o, n); o += 4 * n;
  const score = new Uint16Array(buffer, o, n); o += 2 * n;
  const pr = new Uint16Array(buffer, o, n); o += 2 * n;
  const qr = new Uint16Array(buffer, o, n); o += 2 * n;
  o += (4 - ((6 * n) % 4)) % 4;
  const cat = new Uint8Array(buffer, o, n); o += n;
  const sub = new Uint8Array(buffer, o, n); o += n;
  const flags = new Uint8Array(buffer, o, n); o += n;
  o += (4 - ((3 * n) % 4)) % 4;
  const titleBlob = new Uint8Array(buffer, o, titleBytes); o += titleBytes;
  const wikiBlob = new Uint8Array(buffer, o, wikiBytes);

  // Tiles hold a few hundred rows, so plain objects here cost nothing and keep
  // the rest of the app (deck.gl accessors, tooltips, filters) straightforward.
  const items = new Array(n);
  for (let i = 0; i < n; i++) {
    const title = decoder.decode(titleBlob.subarray(titleOff[i], titleOff[i + 1]));
    const wikiRaw = decoder.decode(wikiBlob.subarray(wikiOff[i], wikiOff[i + 1]));
    // "lang|title"; an empty title part means it equals the drawn label, which
    // is how the encoder avoids storing the same string twice.
    let wikiLang = null;
    let wiki = null;
    if (flags[i] & FLAG_HAS_WIKI) {
      const bar = wikiRaw.indexOf("|");
      wikiLang = bar < 0 ? "en" : wikiRaw.slice(0, bar);
      const rest = bar < 0 ? wikiRaw : wikiRaw.slice(bar + 1);
      wiki = rest || title;
    }
    items[i] = {
      qid: qid[i],
      position: [lon[i], lat[i]],
      title,
      wiki,
      wikiLang,
      hasImage: !!(flags[i] & FLAG_HAS_IMAGE),
      score: score[i] / 65535,
      pr: pr[i] / 65535,
      qr: qr[i] / 65535,
      cat: cat[i],
      sub: sub[i],
    };
  }
  return { z, x, y, items, bytes: buffer.byteLength };
}

export async function fetchTile(url, signal) {
  const response = await fetch(url, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return decodeTile(await maybeGunzip(await response.arrayBuffer()));
}

/** Per-zoom list of tiles that exist, so we never fire a request into a 404. */
export async function fetchTileIndex(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  const buffer = await maybeGunzip(await response.arrayBuffer());
  return new Set(new Uint32Array(buffer));
}
