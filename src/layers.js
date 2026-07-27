// deck.gl layers.
//
// Three layers, drawn bottom to top: a dot for every item in view, a leader
// line for labels that had to be moved off their anchor to fit, and the labels
// themselves for the ones that survive decluttering (see declutter.js - the
// selection happens in main.js so it can be cached across frames).
//
// The dots are never decluttered, so a place whose label lost a collision is
// still visibly there and still hoverable.

import { hexToRgb } from "./categories.js";

const { TextLayer, ScatterplotLayer, LineLayer } = deck;

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// log10 bounds the population term is stretched across. Anchoring the low end
// at a real floor (a small town, not zero) instead of log10(1) means that
// range - where the vast majority of populated items actually live - gets
// most of the 0..1 span, so the slider visibly separates a village from a
// metropolis instead of bunching everything into a narrow middle band. A
// handful of country-scale entries exceed the top and simply clip at 1.
const POP_LOG_MIN = 3; // 1,000
const POP_LOG_MAX = 8; // 100,000,000

// Below this the label is close enough to its dot to be unambiguous.
const LEADER_MIN_PX = 12;

/** Mix the two importance signals the way the slider asks for. */
export function importanceOf(item, qrankWeight) {
  return item.pr * (1 - qrankWeight) + item.qr * qrankWeight;
}

/**
 * What drives label size, and therefore who wins a collision.
 *
 * Importance alone makes a famous ruin outshout the city around it. Population
 * is the other thing people mean by "big", but only two thirds of a million
 * items have one, so it is blended in rather than substituted: items with no
 * population keep their importance and stay comparable.
 */
export function weightOf(item, qrankWeight, populationWeight) {
  const importance = importanceOf(item, qrankWeight);
  if (!populationWeight || item.pop == null) return importance;
  const scaled = Math.max(
    0,
    Math.min(1, (Math.log10(1 + item.pop) - POP_LOG_MIN) / (POP_LOG_MAX - POP_LOG_MIN))
  );
  return importance * (1 - populationWeight) + scaled * populationWeight;
}

/** Label pixel size. Shared with the declutter pass so the boxes it reserves
 *  match what actually gets drawn. */
export function labelSize(item, style) {
  const weight = weightOf(item, style.qrankWeight, style.populationWeight);
  return (10 + 30 * weight * weight) * style.labelScale;
}

export function buildLayers({ items, labelled, style, theme, onHover, onClick }) {
  const colors = style.palette.map(hexToRgb);
  const ink = theme === "dark" ? [242, 242, 240] : [17, 17, 16];
  const halo = theme === "dark" ? [8, 8, 8, 210] : [255, 255, 255, 225];
  const leader = theme === "dark" ? [140, 140, 136, 150] : [110, 110, 105, 140];
  const dotAlpha = theme === "dark" ? 190 : 165;
  const { qrankWeight, labelScale, populationWeight, colorByCategory, labelBudget } =
    style;

  const triggers = {
    qrankWeight,
    labelScale,
    populationWeight,
    colorByCategory,
    theme,
    labelBudget,
  };

  const dots = new ScatterplotLayer({
    id: "dots",
    data: items,
    pickable: true,
    stroked: false,
    filled: true,
    radiusUnits: "pixels",
    radiusMinPixels: 1.2,
    radiusMaxPixels: 9,
    getPosition: (d) => d.position,
    getRadius: (d) =>
      1.4 + 7 * Math.pow(weightOf(d, qrankWeight, populationWeight), 1.6),
    getFillColor: (d) => [...colors[d.cat], dotAlpha],
    updateTriggers: { getRadius: triggers, getFillColor: triggers },
    onHover,
    onClick,
  });

  const displaced = labelled.filter((p) => p.offset > LEADER_MIN_PX);
  const leaders = new LineLayer({
    id: "leaders",
    data: displaced,
    getSourcePosition: (d) => d.item.position,
    getTargetPosition: (d) => d.position,
    getColor: leader,
    getWidth: 1,
    widthUnits: "pixels",
    updateTriggers: { getColor: triggers },
  });

  const labels = new TextLayer({
    id: "labels",
    data: labelled,
    pickable: true,
    getPosition: (d) => d.position,
    getText: (d) => d.item.title,
    getSize: (d) => labelSize(d.item, style),
    sizeUnits: "pixels",
    sizeMinPixels: 9,
    sizeMaxPixels: 46,
    getColor: (d) => (colorByCategory ? colors[d.item.cat] : ink),
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
    layers: [dots, leaders, labels],
    visibleCount: items.length,
    labelledCount: labelled.length,
    displacedCount: displaced.length,
  };
}
