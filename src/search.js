// Prefix search against the static shards built by pipeline/build_search.py.
//
// Typing fetches exactly one small JSON file - the shard for the longest
// prefix that exists (3 characters, else 2, else 1) - and filters inside it.
// The index never loads as a whole, and there is no server.

const MAX_RESULTS = 12;

// Must match RESERVED_NAMES in pipeline/build_search.py: Windows cannot hold a
// file called con.json, so those shards are written with a trailing underscore.
const RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
]);

const shardFile = (prefix) => (RESERVED_NAMES.has(prefix) ? `${prefix}_` : prefix);

/** Must match normalise() in pipeline/build_search.py. */
export function normalise(text) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining marks left by NFKD
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

export class Search {
  constructor({ baseUrl, manifest, categories, input, results, onPick }) {
    this.baseUrl = baseUrl;
    this.categories = categories;
    this.input = input;
    this.results = results;
    this.onPick = onPick;
    this.prefixes = {
      1: new Set(manifest.prefixes["1"]),
      2: new Set(manifest.prefixes["2"]),
      3: new Set(manifest.prefixes["3"]),
    };
    this.shards = new Map();
    this.token = 0;
    this.active = -1;
    this.current = [];
    this.wire();
  }

  wire() {
    let timer = null;
    this.input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.run(this.input.value), 120);
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        this.active = Math.max(
          0,
          Math.min(this.current.length - 1, this.active + step)
        );
        this.paint();
      } else if (event.key === "Enter") {
        const pick = this.current[Math.max(this.active, 0)];
        if (pick) this.choose(pick);
      } else if (event.key === "Escape") {
        this.close();
        this.input.blur();
      }
    });
    document.addEventListener("click", (event) => {
      if (!this.results.contains(event.target) && event.target !== this.input) {
        this.close();
      }
    });
  }

  async shardFor(query) {
    for (const level of [3, 2, 1]) {
      if (query.length < level) continue;
      const prefix = query.slice(0, level);
      if (!this.prefixes[level].has(prefix)) continue;
      const key = `${level}/${prefix}`;
      if (!this.shards.has(key)) {
        this.shards.set(
          key,
          fetch(
            `${this.baseUrl}/search/${level}/${encodeURIComponent(shardFile(prefix))}.json`
          )
            .then((r) => (r.ok ? r.json() : []))
            .catch(() => [])
        );
      }
      return await this.shards.get(key);
    }
    return [];
  }

  async run(raw) {
    const query = normalise(raw);
    if (query.length < 1) return this.close();
    const token = ++this.token;
    const entries = await this.shardFor(query);
    if (token !== this.token) return; // a later keystroke already won

    const scored = [];
    for (const entry of entries) {
      const name = normalise(entry[0]);
      let rank;
      if (name.startsWith(query)) rank = 0;
      else if (name.split(" ").some((w) => w.startsWith(query))) rank = 1;
      else if (name.includes(query)) rank = 2;
      else continue;
      scored.push({ entry, rank });
    }
    scored.sort((a, b) => a.rank - b.rank || b.entry[4] - a.entry[4]);
    this.current = scored.slice(0, MAX_RESULTS).map((s) => s.entry);
    this.active = this.current.length ? 0 : -1;
    this.paint();
  }

  paint() {
    this.results.textContent = "";
    if (!this.current.length) return this.close();
    this.current.forEach((entry, i) => {
      const [name, , , , , cat] = entry;
      const row = document.createElement("div");
      row.className = "result";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === this.active));

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = this.categories.style?.palette?.[cat] ?? "transparent";

      const label = document.createElement("span");
      label.className = "name";
      label.textContent = name;

      const kind = document.createElement("span");
      kind.className = "cat";
      kind.textContent = this.categories.categories[cat]?.name ?? "";

      row.append(swatch, label, kind);
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.choose(entry);
      });
      this.results.append(row);
    });
    this.results.classList.add("open");
  }

  choose(entry) {
    const [name, lon, lat, qid, score, cat] = entry;
    this.close();
    this.input.value = name;
    this.onPick({ name, lon, lat, qid, score, cat });
  }

  close() {
    this.results.classList.remove("open");
    this.results.textContent = "";
    this.current = [];
    this.active = -1;
  }
}
