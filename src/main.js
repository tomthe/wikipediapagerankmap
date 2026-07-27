// Wiring: load the manifests, create the deck.gl map, keep tiles, filters and
// panels in sync.
//
// Rendering and tile loading are deliberately decoupled. Every view change
// redraws immediately from whatever is already cached, and only *schedules*
// tile work. That is why the map never blanks while panning - the old version
// redrew from the result of a debounced fetch, so a slow tile meant an empty
// screen.

import { TileManager } from "./tiles.js";
import { CategoryFilter } from "./categories.js";
import { buildLayers, importanceOf, labelSize } from "./layers.js";
import { selectLabels } from "./declutter.js";
import { Search } from "./search.js";
import { Tooltip, DetailPanel } from "./ui.js";

const DATA_URL = "data";
// Settlements and Administrative are the two categories the importance score
// already favours - they dominate every zoom and mostly restate what the
// basemap says. Starting with them off makes the first view show the things
// people came for, and both are one click away.
const DEFAULT_OFF = ["Settlements", "Administrative"];
const BASEMAPS = {
  light: "https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json",
};

const $ = (id) => document.getElementById(id);

const state = {
  theme: localStorage.getItem("wikimap-theme") ?? "light",
  viewState: { longitude: 8, latitude: 47, zoom: 3.4, pitch: 0, bearing: 0 },
  style: {
    qrankWeight: 0.5,
    labelScale: 1,
    minImportance: 0,
    labelBudget: 300,
    colorByCategory: false,
    palette: [],
  },
  hovered: null,
};

let deckgl;
let tiles;
let filter;
let tooltip;
let detail;
let manifest;
let scheduled = null;

// ---------------------------------------------------------------- view state

function readHash() {
  const match = /^#(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(
    location.hash
  );
  if (!match) return null;
  const [, zoom, latitude, longitude] = match.map(Number);
  return { zoom, latitude, longitude, pitch: 0, bearing: 0 };
}

let hashTimer = null;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const { zoom, latitude, longitude } = state.viewState;
    const hash = `#${zoom.toFixed(2)}/${latitude.toFixed(4)}/${longitude.toFixed(4)}`;
    history.replaceState(null, "", hash);
  }, 300);
}

function currentViewport() {
  return new deck.WebMercatorViewport({
    ...state.viewState,
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

// ------------------------------------------------------------------ rendering

// Which items carry a label. Recomputed when the view settles rather than every
// frame: the selection depends on screen positions, so redoing it mid-drag
// would make labels flicker in and out, and the chosen set stays correct while
// panning because labels are anchored to the map.
let labelled = [];
let labelTimer = null;

/** Screen rectangles the labels should keep out of: the panels sit on top of
 *  the map, and a label underneath one is a label nobody can read. */
function panelRects() {
  const rects = [];
  for (const id of ["controls", "status", "detail"]) {
    const el = $(id);
    if (!el || el.offsetParent === null) continue;
    const b = el.getBoundingClientRect();
    rects.push({ x0: b.left - 4, y0: b.top - 4, x1: b.right + 4, y1: b.bottom + 4 });
  }
  return rects;
}

function chooseLabels(items) {
  labelled = selectLabels({
    items,
    viewport: currentViewport(),
    importance: (item) => importanceOf(item, state.style.qrankWeight),
    sizeOf: (item) =>
      labelSize(item, state.style.qrankWeight, state.style.labelScale),
    budget: state.style.labelBudget,
    avoid: panelRects(),
  });
}

function scheduleLabels(items) {
  clearTimeout(labelTimer);
  labelTimer = setTimeout(() => {
    chooseLabels(items);
    render();
  }, 130);
}

function render({ reselect = false } = {}) {
  // The panel is live while the tile indexes are still downloading, so a click
  // can land here before there is anything to draw into.
  if (!deckgl) return;
  const items = tiles.visibleItems().filter((item) => filter.accept(item));
  if (reselect) chooseLabels(items);
  const { layers, visibleCount } = buildLayers({
    items,
    labelled,
    style: state.style,
    theme: state.theme,
    onHover: onHover,
    onClick: onClick,
  });
  deckgl.setProps({ layers, viewState: state.viewState });
  filter.updateCounts(items);
  updateStatus(visibleCount, labelled.length);
  return items;
}

function scheduleTiles() {
  if (scheduled) return;
  scheduled = requestAnimationFrame(() => {
    scheduled = null;
    tiles.update(currentViewport().getBounds(), state.viewState.zoom);
  });
}

function updateStatus(inView, labelCount) {
  const s = tiles.stats();
  const busy = s.pending + s.queued > 0;
  $("status").classList.toggle("busy", busy);
  $("status-text").textContent =
    `${labelCount.toLocaleString()} labels of ${inView.toLocaleString()} places · ` +
    `${s.needed} tiles in view · ${s.cached.toLocaleString()} cached · ` +
    `${s.megabytes.toFixed(1)} MB loaded` +
    (busy ? ` · loading ${s.pending + s.queued}` : "");
}

// ------------------------------------------------------------------ callbacks

function onViewStateChange({ viewState }) {
  state.viewState = viewState;
  const items = render();      // immediate, from cache
  scheduleLabels(items ?? []); // re-declutter once the view settles
  scheduleTiles();             // fetch what is missing, without blocking the draw
  writeHash();
}

function onHover(info) {
  const item = info.object ?? null;
  if (item !== state.hovered) {
    state.hovered = item;
    tooltip.show(item, info.x, info.y);
  } else if (item) {
    tooltip.show(item, info.x, info.y);
  }
}

function onClick(info) {
  if (info.object) detail.open(info.object);
}

function flyTo(longitude, latitude, zoom) {
  state.viewState = {
    ...state.viewState,
    longitude,
    latitude,
    zoom,
    transitionDuration: 1200,
    transitionInterpolator: new deck.FlyToInterpolator({ speed: 1.6 }),
  };
  render();
  setTimeout(() => render({ reselect: true }), 1400);
  scheduleTiles();
}

// ---------------------------------------------------------------------- theme

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("wikimap-theme", theme);
  state.style.palette = manifest.palette[theme];
  filter?.setPalette(state.style.palette);
  // The scripting bundle has changed how it exposes the basemap between
  // versions; if none of these work the labels still retheme, only the tiles
  // underneath stay put.
  const map =
    deckgl?.getMapboxMap?.() ?? deckgl?.getMapLibreMap?.() ?? deckgl?._map ?? null;
  if (map?.setStyle) map.setStyle(BASEMAPS[theme]);
  render();
}

// ----------------------------------------------------------------- controls

function wireControls() {
  $("theme-btn").addEventListener("click", () =>
    applyTheme(state.theme === "dark" ? "light" : "dark")
  );

  const weight = $("weight");
  weight.addEventListener("input", () => {
    const v = Number(weight.value) / 100;
    state.style.qrankWeight = v;
    $("weight-out").textContent =
      v < 0.35 ? "link structure" : v > 0.65 ? "pageviews" : "balanced";
    render({ reselect: true });
  });

  const minscore = $("minscore");
  minscore.addEventListener("input", () => {
    // Squared so the low end of the slider, where almost everything lives, is
    // where most of the travel goes.
    const v = Math.pow(Number(minscore.value) / 100, 2);
    state.style.minImportance = v;
    $("minscore-out").textContent = v === 0 ? "all" : `≥ ${(v * 100).toFixed(1)}`;
    render({ reselect: true });
  });

  const labelbudget = $("labelbudget");
  labelbudget.addEventListener("input", () => {
    state.style.labelBudget = Number(labelbudget.value);
    $("labelbudget-out").textContent = labelbudget.value;
    render({ reselect: true });
  });

  const labelscale = $("labelscale");
  labelscale.addEventListener("input", () => {
    const v = Number(labelscale.value) / 100;
    state.style.labelScale = v;
    $("labelscale-out").textContent = `${v.toFixed(1)}×`;
    render({ reselect: true });
  });

  $("color-by-cat").addEventListener("change", (event) => {
    state.style.colorByCategory = event.target.checked;
    render();
  });

  // Starts false because two categories start off, so the first click should
  // turn everything on rather than clear what is already a partial selection.
  let allOn = false;
  $("cat-all").addEventListener("click", () => {
    allOn = !allOn;
    filter.setAll(allOn);
  });
}

// -------------------------------------------------------------------- startup

async function start() {
  manifest = await fetch(`${DATA_URL}/manifest.json`).then((r) => {
    if (!r.ok) throw new Error("data/manifest.json not found - run the pipeline first");
    return r.json();
  });

  state.style.palette = manifest.palette[state.theme];
  document.documentElement.dataset.theme = state.theme;

  filter = new CategoryFilter({
    manifest,
    container: $("categories"),
    defaultOff: DEFAULT_OFF,
    onChange: () => render({ reselect: true }),
  });
  filter.setPalette(state.style.palette);

  tiles = new TileManager({
    baseUrl: DATA_URL,
    manifest,
    onUpdate: () => render({ reselect: true }),
  });
  await tiles.loadIndexes();

  const fromHash = readHash();
  if (fromHash) state.viewState = { ...state.viewState, ...fromHash };

  deckgl = new deck.DeckGL({
    container: "map",
    mapStyle: BASEMAPS[state.theme],
    viewState: state.viewState,
    controller: { doubleClickZoom: false, inertia: 250 },
    onViewStateChange,
    layers: [],
    getCursor: ({ isHovering }) => (isHovering ? "pointer" : "grab"),
  });

  tooltip = new Tooltip($("tooltip"), { categories: manifest });
  detail = new DetailPanel({
    panel: $("detail"),
    body: $("detail-body"),
    closeButton: $("detail-close"),
    categories: manifest,
  });

  wireControls();

  // The search manifest lists every prefix that exists, which is over a
  // megabyte. Deliberately not awaited: the map should be usable before it
  // lands, and search wires itself up when it does.
  $("search").placeholder = "loading search index…";
  fetch(`${DATA_URL}/search/manifest.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((searchManifest) => {
      if (!searchManifest) throw new Error("no search index");
      new Search({
        baseUrl: DATA_URL,
        manifest: searchManifest,
        // state.style is passed live so results restyle when the theme changes.
        categories: { categories: manifest.categories, style: state.style },
        input: $("search"),
        results: $("results"),
        onPick: ({ lon, lat }) => flyTo(lon, lat, Math.max(state.viewState.zoom, 11)),
      });
      $("search").placeholder = "Search places…";
    })
    .catch(() => {
      $("search").placeholder = "search index not built";
      $("search").disabled = true;
    });

  $("data-note").textContent =
    `${manifest.itemCount.toLocaleString()} geolocated articles in ` +
    `${manifest.tileCount.toLocaleString()} tiles · zoom 0–${manifest.maxZoom}`;

  window.addEventListener("resize", () => scheduleTiles());
  $("loading").classList.add("hidden");

  scheduleTiles();
  render({ reselect: true });
}

start().catch((err) => {
  console.error(err);
  $("loading").textContent = String(err.message ?? err);
});
