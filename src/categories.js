// Category / subcategory filter: builds the panel and answers "draw this item?".

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const SUB_STRIDE = 256;

export class CategoryFilter {
  constructor({ manifest, container, onChange, defaultOff = [] }) {
    this.categories = manifest.categories;
    this.container = container;
    this.onChange = onChange;
    // Flat lookup keyed by cat*256+sub: filtering runs over every visible item
    // on every render, so it should not walk Sets. render() fills it.
    this.lookup = new Uint8Array(this.categories.length * SUB_STRIDE);
    const off = new Set(defaultOff);
    this.catOn = new Map(this.categories.map((c) => [c.id, !off.has(c.name)]));
    this.subOn = new Map(
      this.categories.map((c) => [
        c.id,
        new Set(off.has(c.name) ? [] : c.subcategories.map((_, i) => i)),
      ])
    );
    this.countEls = new Map();
    this.render();
  }

  accept(item) {
    return this.lookup[item.cat * SUB_STRIDE + item.sub] === 1;
  }

  rebuildLookup() {
    this.lookup.fill(0);
    for (const cat of this.categories) {
      if (!this.catOn.get(cat.id)) continue;
      const subs = this.subOn.get(cat.id);
      for (const sub of subs) this.lookup[cat.id * SUB_STRIDE + sub] = 1;
      // Items can carry a subcategory id beyond the named list only if the
      // manifest and tiles disagree; be permissive rather than silently blank.
      for (let s = cat.subcategories.length; s < SUB_STRIDE; s++) {
        this.lookup[cat.id * SUB_STRIDE + s] = subs.has(0) ? 1 : 0;
      }
    }
  }

  setAll(on) {
    for (const cat of this.categories) {
      this.catOn.set(cat.id, on);
      const subs = this.subOn.get(cat.id);
      subs.clear();
      if (on) cat.subcategories.forEach((_, i) => subs.add(i));
    }
    this.rebuildLookup();
    this.syncInputs();
    this.onChange?.();
  }

  syncInputs() {
    for (const input of this.container.querySelectorAll("input[data-cat]")) {
      const catId = Number(input.dataset.cat);
      if (input.dataset.sub === undefined) {
        input.checked = this.catOn.get(catId);
      } else {
        input.checked = this.subOn.get(catId).has(Number(input.dataset.sub));
      }
    }
  }

  /** Show how many of the items on screen fall in each category. */
  updateCounts(items) {
    const counts = new Array(this.categories.length).fill(0);
    for (const item of items) counts[item.cat] = (counts[item.cat] || 0) + 1;
    for (const [catId, el] of this.countEls) {
      el.textContent = counts[catId] ? counts[catId].toLocaleString() : "";
    }
  }

  setPalette(colors) {
    this.colors = colors;
    for (const [catId, swatch] of this.swatches ?? []) {
      swatch.style.background = colors[catId];
    }
  }

  render() {
    this.container.textContent = "";
    this.swatches = new Map();
    for (const cat of this.categories) {
      const row = document.createElement("div");
      row.className = "cat-row";

      const twisty = document.createElement("button");
      twisty.className = "twisty";
      twisty.type = "button";
      twisty.textContent = "▶";
      twisty.title = "Show subcategories";

      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = this.catOn.get(cat.id);
      box.dataset.cat = String(cat.id);

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      this.swatches.set(cat.id, swatch);

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = cat.name;

      const count = document.createElement("span");
      count.className = "count";
      this.countEls.set(cat.id, count);

      label.append(box, swatch, name, count);
      row.append(twisty, label);

      const subs = document.createElement("div");
      subs.className = "subs";
      cat.subcategories.forEach((subName, subId) => {
        const subLabel = document.createElement("label");
        const subBox = document.createElement("input");
        subBox.type = "checkbox";
        subBox.checked = this.subOn.get(cat.id).has(subId);
        subBox.dataset.cat = String(cat.id);
        subBox.dataset.sub = String(subId);
        const text = document.createElement("span");
        text.textContent = subName || "Other";
        subLabel.append(subBox, text);
        subs.append(subLabel);

        subBox.addEventListener("change", () => {
          const set = this.subOn.get(cat.id);
          if (subBox.checked) set.add(subId);
          else set.delete(subId);
          // Turning any subcategory on implies the category itself is on.
          this.catOn.set(cat.id, set.size > 0);
          box.checked = set.size > 0;
          this.rebuildLookup();
          this.onChange?.();
        });
      });

      twisty.addEventListener("click", () => {
        const open = subs.classList.toggle("open");
        twisty.textContent = open ? "▼" : "▶";
      });

      box.addEventListener("change", () => {
        this.catOn.set(cat.id, box.checked);
        const set = this.subOn.get(cat.id);
        set.clear();
        if (box.checked) cat.subcategories.forEach((_, i) => set.add(i));
        this.rebuildLookup();
        this.syncInputs();
        this.onChange?.();
      });

      this.container.append(row, subs);
    }
    this.rebuildLookup();
  }
}
