// The basemap underneath the labels.
//
// OpenFreeMap rather than CARTO. CARTO's tiles work without a key, but their
// terms have no anonymous tier - free use is for "CARTO grantees" and
// commercial use needs an Enterprise licence - so the map was running on
// something it was not entitled to and could have been rate-limited without
// warning. OpenFreeMap states no limit on views or requests, allows commercial
// use, needs no key or registration, and can be self-hosted if the donated
// hosting ever goes away.
//
// The catch is that OpenFreeMap has no no-labels variant, and this map is
// nothing but labels - two sets of place names on top of each other is
// unreadable. So the style is fetched and every layer that draws text is
// dropped before MapLibre sees it. That is also why the style is an object
// rather than a URL, and why it has to be resolved before the map is created.
//
// Attribution is required and their style JSON does not carry it, so it is
// attached to the sources here, where MapLibre's attribution control finds it.

const STYLE_URL = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '&copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

/** Land-coloured nothing, for when the style server cannot be reached. */
function fallbackStyle(theme) {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": theme === "dark" ? "#0c0c0c" : "#f2f3f0" },
      },
    ],
  };
}

const cache = new Map();

export async function basemapStyle(theme) {
  if (cache.has(theme)) return cache.get(theme);
  const promise = fetch(STYLE_URL[theme])
    .then((r) => {
      if (!r.ok) throw new Error(`${r.status} for ${STYLE_URL[theme]}`);
      return r.json();
    })
    .then((style) => {
      // Anything with a text-field: place names, road names, shields, water
      // names. Icon-only layers stay - they are small and do not compete.
      style.layers = style.layers.filter(
        (layer) => !(layer.layout && layer.layout["text-field"])
      );
      for (const source of Object.values(style.sources ?? {})) {
        source.attribution = ATTRIBUTION;
      }
      return style;
    })
    .catch((err) => {
      console.warn("basemap style unavailable, drawing labels on plain ground", err);
      return fallbackStyle(theme);
    });
  cache.set(theme, promise);
  // A copy each time: MapLibre takes ownership of the object it is handed, and
  // toggling the theme twice would otherwise pass back one it has already
  // rewritten.
  return promise.then((style) => structuredClone(style));
}
