// Drive the real UI over the DevTools protocol: category filtering, search,
// and the detail panel. Screenshots prove it renders; this proves it works.
//
//   node tests/interaction_check.mjs [url]
//
// Needs a headless Chromium on --remote-debugging-port=9222 (see
// browser_check.mjs for the launch line). Exits non-zero on any failed step.

const url = process.argv[2] ?? "http://127.0.0.1:8765/";
const CDP = "http://127.0.0.1:9222";

const targets = await (await fetch(`${CDP}/json`)).json();
const page = targets.find((t) => t.type === "page");
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const waiting = new Map();
const problems = [];

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => waiting.set(id, resolve));
}
socket.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg.result);
    waiting.delete(msg.id);
  } else if (msg.method === "Runtime.exceptionThrown") {
    problems.push(
      "exception: " +
        (msg.params.exceptionDetails.exception?.description ??
          msg.params.exceptionDetails.text)
    );
  }
});
await new Promise((r) => socket.addEventListener("open", r, { once: true }));
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.enable");

const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? "eval failed");
  }
  return res.result?.value;
};

const step = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + detail}`);
  if (!ok) problems.push(name);
};

await send("Page.navigate", { url });
await new Promise((r) => setTimeout(r, 16000));

const sleep = (ms) => `new Promise(r => setTimeout(r, ${ms}))`;

// --- 1. baseline ------------------------------------------------------------
const base = await evaluate(`(() => {
  const s = document.getElementById("status-text").textContent;
  const m = /^([\\d,]+) labels of ([\\d,]+) places/.exec(s);
  const n = (v) => Number(v.replace(/,/g, ""));
  return { labels: n(m[1]), places: n(m[2]), status: s };
})()`);
step("map has drawn labels", base.labels > 0, base.status);
step("map has more places than labels", base.places > base.labels, base.status);

// Checked here, before anything else touches the panel: later steps switch
// categories on deliberately, so this is the only point where the default
// selection is still the default.
const defaults = await evaluate(`(() => {
  const boxes = [...document.querySelectorAll('#categories input[data-cat]')]
    .filter(b => b.dataset.sub === undefined);
  return {
    total: boxes.length,
    off: boxes.filter(b => !b.checked)
      .map(b => b.closest(".cat-row").querySelector(".name").textContent),
  };
})()`);
step(
  "some categories start switched off",
  defaults.off.length > 0 && defaults.off.length < defaults.total,
  `${defaults.total} categories, off: ${JSON.stringify(defaults.off)}`
);

// --- 2. unchecking a category removes its items -----------------------------
const filtered = await evaluate(`(async () => {
  const rows = [...document.querySelectorAll("#categories .cat-row")];
  const other = rows.find(r => r.querySelector(".name")?.textContent === "Other");
  const box = other.querySelector('input[type="checkbox"]');
  const before = document.getElementById("status-text").textContent;
  box.click();
  await ${sleep(1200)};
  const after = document.getElementById("status-text").textContent;
  const n = (s) => Number(/of ([\\d,]+) places/.exec(s)[1].replace(/,/g, ""));
  return { before: n(before), after: n(after), checked: box.checked };
})()`);
step(
  "unchecking Other reduces the place count",
  filtered.after < filtered.before && filtered.checked === false,
  `${filtered.before} -> ${filtered.after}`
);

const restored = await evaluate(`(async () => {
  const rows = [...document.querySelectorAll("#categories .cat-row")];
  const other = rows.find(r => r.querySelector(".name")?.textContent === "Other");
  other.querySelector('input[type="checkbox"]').click();
  await ${sleep(1200)};
  return Number(/of ([\\d,]+) places/.exec(
    document.getElementById("status-text").textContent)[1].replace(/,/g, ""));
})()`);
step("re-checking restores it", restored === filtered.before, `${restored} vs ${filtered.before}`);

// --- 3. subcategories are listed and toggleable -----------------------------
const subs = await evaluate(`(async () => {
  const rows = [...document.querySelectorAll("#categories .cat-row")];
  const nature = rows.find(r => r.querySelector(".name")?.textContent === "Nature");
  nature.querySelector(".twisty").click();
  await ${sleep(300)};
  const panel = nature.nextElementSibling;
  return { open: panel.classList.contains("open"), count: panel.querySelectorAll("label").length };
})()`);
step("subcategories expand", subs.open && subs.count > 5, JSON.stringify(subs));

// --- 4. search finds a place and flies to it --------------------------------
const search = await evaluate(`(async () => {
  const input = document.getElementById("search");
  if (input.disabled) return { skipped: true };
  input.focus();
  input.value = "Rostock";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await ${sleep(2500)};
  const results = [...document.querySelectorAll("#results .result")];
  const names = results.slice(0, 3).map(r => r.querySelector(".name").textContent);
  const hashBefore = location.hash;
  if (results.length) {
    results[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  }
  await ${sleep(3000)};
  return { count: results.length, names, hashBefore, hashAfter: location.hash };
})()`);
if (search.skipped) {
  step("search index available", false, "input disabled");
} else {
  step("search returns results", search.count > 0, JSON.stringify(search.names));
  step(
    "picking a result moves the map",
    search.hashAfter !== search.hashBefore,
    `${search.hashBefore} -> ${search.hashAfter}`
  );
}

// --- 5. the detail panel opens with real content ----------------------------
const detail = await evaluate(`(async () => {
  // Reach into deck.gl's layer data rather than guessing pixel coordinates.
  const items = window.__probeItems?.() ?? null;
  return items;
})()`);
// No test hook in production code, so drive the panel the way a click would.
const panel = await evaluate(`(async () => {
  const mod = await import("./src/ui.js");
  const manifest = await (await fetch("data/manifest.json")).json();
  const p = new mod.DetailPanel({
    panel: document.getElementById("detail"),
    body: document.getElementById("detail-body"),
    closeButton: document.getElementById("detail-close"),
    categories: manifest,
  });
  p.open({
    qid: 1794, title: "Frankfurt", wiki: "Frankfurt", wikiLang: "en",
    position: [8.6821, 50.1109], score: 0.8, pr: 0.8, qr: 0.8, cat: 1, sub: 2,
    hasImage: true,
  });
  await ${sleep(4000)};
  const body = document.getElementById("detail-body");
  const links = [...body.querySelectorAll(".links a")].map(a => a.textContent);
  return {
    open: document.getElementById("detail").classList.contains("open"),
    heading: body.querySelector("h2")?.textContent,
    extractLength: (body.querySelector(".extract")?.textContent ?? "").length,
    hasImage: !!body.querySelector("img:not([hidden])"),
    links,
  };
})()`);
step("detail panel opens", panel.open && panel.heading === "Frankfurt", JSON.stringify(panel));
step("wikipedia summary loads", panel.extractLength > 80, `${panel.extractLength} chars`);
step("thumbnail loads", panel.hasImage, "no img");
step(
  "all four links present",
  panel.links.length === 4 && panel.links[0].startsWith("Wikipedia"),
  JSON.stringify(panel.links)
);

// --- 6. the density slider caps the label count -----------------------------
// Asserted as "the cap binds", not "more labels appear": how many labels fit is
// set by decluttering, so raising the cap past what fits changes nothing.
const slider = await evaluate(`(async () => {
  document.getElementById("detail-close").click();
  // Turn every category on first. The default view hides two of them, and with
  // those gone fewer labels fit than the smallest budget allows, so the cap
  // would never bind and this would test nothing.
  for (const box of document.querySelectorAll("#categories input[data-cat]:not([data-sub])")) {
    if (box.checked) continue;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  }
  await ${sleep(1500)};
  const el = document.getElementById("labelbudget");
  const n = () => Number(
    /^([\\d,]+) labels/.exec(document.getElementById("status-text").textContent)[1]
      .replace(/,/g, ""));
  el.value = "50";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await ${sleep(1500)};
  const low = n();
  el.value = "800";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await ${sleep(1500)};
  const high = n();
  return { low, high };
})()`);
step(
  "label density slider caps the label count",
  slider.low <= 50 && slider.high > slider.low,
  `budget 50 -> ${slider.low} labels; budget 800 -> ${slider.high}`
);

// --- 7. all / none ----------------------------------------------------------
const allNone = await evaluate(`(async () => {
  const boxes = () => [...document.querySelectorAll('#categories input[data-cat]')]
    .filter(b => b.dataset.sub === undefined);
  const checked = () => boxes().filter(b => b.checked).length;
  document.getElementById("cat-all").click();
  await ${sleep(1200)};
  const afterFirst = checked();
  document.getElementById("cat-all").click();
  await ${sleep(1200)};
  const afterSecond = checked();
  return { total: boxes().length, afterFirst, afterSecond };
})()`);
step(
  "all / none clears every category, and restores them",
  (allNone.afterFirst === allNone.total && allNone.afterSecond === 0) ||
    (allNone.afterFirst === 0 && allNone.afterSecond === allNone.total),
  JSON.stringify(allNone)
);

socket.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s): ${problems.join("; ")}`);
  process.exit(1);
}
console.log("\nall interactions work");
