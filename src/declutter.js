// Screen-space label selection.
//
// deck.gl ships a CollisionFilterExtension that does this on the GPU, and the
// old version of this map used it. It is replaced here because its behaviour
// depends on the renderer: on a software rasteriser it culled 297 of 300
// labels over central Paris, and there is no way to detect that from inside
// the page. Doing the work in JS is a few milliseconds and always produces the
// same answer.
//
// The method is the standard one: walk candidates in importance order, keep a
// label if its box does not touch a box already kept, and stop at the budget.
// An occupancy grid makes the overlap test O(1) per label.

const CELL = 20; // px; smaller than a label, so a box covers several cells
const MARGIN = 140; // px of off-screen slack, so labels do not pop at the edge

// Text width depends on the string, and measuring is far too slow to redo per
// frame - but titles repeat across every render, so measure once and keep it.
const emWidths = new Map();
let context = null;

function emWidth(text) {
  let width = emWidths.get(text);
  if (width !== undefined) return width;
  if (!context) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    context = canvas.getContext("2d");
    context.font = '500 32px system-ui, -apple-system, "Segoe UI", sans-serif';
  }
  width = context.measureText(text).width / 32;
  emWidths.set(text, width);
  if (emWidths.size > 60000) emWidths.clear(); // bounded, rebuilt lazily
  return width;
}

/**
 * @returns the items that should get a label, most important first.
 */
export function selectLabels({ items, viewport, importance, sizeOf, budget, avoid = [] }) {
  const occupied = new Set();
  const kept = [];
  const width = viewport.width;
  const height = viewport.height;
  const cellKey = (cx, cy) => (cx + 4096) * 32768 + (cy + 4096);

  // Block out the panels first, so no label is drawn where it cannot be read.
  for (const rect of avoid) {
    const cx1 = Math.floor(rect.x1 / CELL);
    const cy1 = Math.floor(rect.y1 / CELL);
    for (let cy = Math.floor(rect.y0 / CELL); cy <= cy1; cy++) {
      for (let cx = Math.floor(rect.x0 / CELL); cx <= cx1; cx++) {
        occupied.add(cellKey(cx, cy));
      }
    }
  }

  // Importance order decides who wins a collision, so sort once up front.
  const ranked = items
    .map((item) => ({ item, value: importance(item) }))
    .sort((a, b) => b.value - a.value);

  for (const { item } of ranked) {
    if (kept.length >= budget) break;
    const [x, y] = viewport.project(item.position);
    if (x < -MARGIN || y < -MARGIN || x > width + MARGIN || y > height + MARGIN) {
      continue;
    }
    const size = sizeOf(item);
    const halfW = (emWidth(item.title) * size) / 2 + 3;
    const halfH = size / 2 + 2;

    const cx0 = Math.floor((x - halfW) / CELL);
    const cx1 = Math.floor((x + halfW) / CELL);
    const cy0 = Math.floor((y - halfH) / CELL);
    const cy1 = Math.floor((y + halfH) / CELL);

    let blocked = false;
    for (let cy = cy0; cy <= cy1 && !blocked; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (occupied.has(cellKey(cx, cy))) {
          blocked = true;
          break;
        }
      }
    }
    if (blocked) continue;

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        occupied.add(cellKey(cx, cy));
      }
    }
    kept.push(item);
  }
  return kept;
}
