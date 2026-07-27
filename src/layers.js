// deck.gl layers.
//
// Two layers, drawn bottom to top: a dot for every item in view, and a label
// for the ones that survive decluttering (see declutter.js - the selection
// happens in main.js so it can be cached across frames).
//
// The dots are never decluttered, so a place whose label lost a collision is
// still visibly there and still hoverable.

import { hexToRgb } from "./categories.js";

const { TextLayer, ScatterplotLayer } = deck;

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Mix the two importance signals the way the slider asks for. */
export function importanceOf(item, qrankWeight) {
  return item.pr * (1 - qrankWeight) + item.qr * qrankWeight;
}

/** Label pixel size from importance. Shared with the declutter pass so the
 *  boxes it reserves match what actually gets drawn. */
export function labelSize(item, qrankWeight, labelScale) {
  return (10 + 30 * Math.pow(importanceOf(item, qrankWeight), 2.0)) * labelScale;
}

export function buildLayers({ items, labelled, style, theme, onHover, onClick }) {
  const colors = style.palette.map(hexToRgb);
  const ink = theme === "dark" ? [242, 242, 240] : [17, 17, 16];
  const halo = theme === "dark" ? [8, 8, 8, 210] : [255, 255, 255, 225];
  const dotAlpha = theme === "dark" ? 190 : 165;
  const { qrankWeight, labelScale, minImportance, colorByCategory, labelBudget } =
    style;

  const visible = items.filter(
    (item) => importanceOf(item, qrankWeight) >= minImportance
  );
  const sizeFor = (item) => labelSize(item, qrankWeight, labelScale);
  const triggers = { qrankWeight, labelScale, colorByCategory, theme, labelBudget };

  const dots = new ScatterplotLayer({
    id: "dots",
    data: visible,
    pickable: true,
    stroked: false,
    filled: true,
    radiusUnits: "pixels",
    radiusMinPixels: 1.2,
    radiusMaxPixels: 9,
    getPosition: (d) => d.position,
    getRadius: (d) => 1.4 + 7 * Math.pow(importanceOf(d, qrankWeight), 1.6),
    getFillColor: (d) => [...colors[d.cat], dotAlpha],
    updateTriggers: { getRadius: triggers, getFillColor: triggers },
    onHover,
    onClick,
  });

  const labels = new TextLayer({
    id: "labels",
    data: labelled,
    pickable: true,
    getPosition: (d) => d.position,
    getText: (d) => d.title,
    getSize: sizeFor,
    sizeUnits: "pixels",
    sizeMinPixels: 9,
    sizeMaxPixels: 46,
    getColor: (d) => (colorByCategory ? colors[d.cat] : ink),
    getTextAnchor: "middle",
    getAlignmentBaseline: "center",
    fontFamily: FONT_FAMILY,
    fontWeight: 500,
    characterSet: "auto",
    // A signed-distance field is what makes the halo possible, and the halo is
    // what keeps a label readable over coastlines and roads.
    fontSettings: { sdf: true, fontSize: 52, buffer: 12, radius: 16 },
    outlineWidth: 2.5,
    outlineColor: halo,
    updateTriggers: { getSize: triggers, getColor: triggers },
    onHover,
    onClick,
  });

  return {
    layers: [dots, labels],
    visibleCount: visible.length,
    labelledCount: labelled.length,
  };
}
