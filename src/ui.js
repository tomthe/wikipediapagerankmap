// Hover tooltip and the click-through detail panel.
//
// Tiles deliberately carry only what the map needs to draw (name, category,
// two importance numbers). Everything richer - the summary text and the
// thumbnail - is fetched from Wikipedia on demand for the one item that was
// clicked, so no byte of it is paid for while panning.

const wikiHost = (lang) => `https://${lang || "en"}.wikipedia.org`;
const articleUrl = (lang, title) =>
  `${wikiHost(lang)}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
const summaryUrl = (lang, title) =>
  `${wikiHost(lang)}/api/rest_v1/page/summary/${encodeURIComponent(
    title.replace(/ /g, "_")
  )}`;

export class Tooltip {
  constructor(element, { categories }) {
    this.el = element;
    this.categories = categories;
  }

  show(item, x, y) {
    if (!item) return this.hide();
    const cat = this.categories.categories[item.cat];
    const sub = cat?.subcategories?.[item.sub];
    const kind = sub && sub !== "Other" ? `${sub} · ${cat.name}` : cat?.name ?? "";
    this.el.innerHTML = "";
    const name = document.createElement("div");
    name.className = "t-name";
    name.textContent = item.title;
    const meta = document.createElement("div");
    meta.className = "t-meta";
    meta.textContent =
      `${kind} · importance ${(item.score * 100).toFixed(0)}` +
      (item.wiki
        ? item.wikiLang === "en"
          ? ""
          : ` · ${item.wikiLang}.wikipedia`
        : " · no article");
    this.el.append(name, meta);
    this.el.style.display = "block";
    // Keep the tooltip on screen near the right and bottom edges.
    const box = this.el.getBoundingClientRect();
    const left = Math.min(x + 14, window.innerWidth - box.width - 8);
    const top = Math.min(y + 14, window.innerHeight - box.height - 8);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  hide() {
    this.el.style.display = "none";
  }
}

export class DetailPanel {
  constructor({ panel, body, closeButton, categories }) {
    this.panel = panel;
    this.body = body;
    this.categories = categories;
    this.controller = null;
    closeButton.addEventListener("click", () => this.close());
  }

  close() {
    this.panel.classList.remove("open");
    this.controller?.abort();
    this.controller = null;
  }

  open(item) {
    this.controller?.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;

    const cat = this.categories.categories[item.cat];
    const sub = cat?.subcategories?.[item.sub];
    const [lon, lat] = item.position;

    this.body.textContent = "";

    const title = document.createElement("h2");
    title.textContent = item.title;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [sub && sub !== "Other" ? sub : null, cat?.name]
      .filter(Boolean)
      .join(" · ");

    const figure = document.createElement("img");
    figure.alt = "";
    figure.hidden = true;

    const extract = document.createElement("p");
    extract.className = "extract";
    extract.textContent = item.wiki ? "Loading summary…" : "";

    const facts = document.createElement("dl");
    const addFact = (key, value) => {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      facts.append(dt, dd);
    };
    addFact("Importance", `${(item.score * 100).toFixed(1)} / 100`);
    addFact("PageRank", `${(item.pr * 100).toFixed(1)} / 100`);
    addFact("Pageviews", `${(item.qr * 100).toFixed(1)} / 100`);
    addFact("Coordinates", `${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    addFact("Wikidata", `Q${item.qid}`);

    const links = document.createElement("div");
    links.className = "links";
    const addLink = (label, href) => {
      const a = document.createElement("a");
      a.textContent = label;
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      links.append(a);
    };
    if (item.wiki) {
      const lang = item.wikiLang || "en";
      addLink(
        lang === "en" ? "Wikipedia" : `Wikipedia (${lang})`,
        articleUrl(lang, item.wiki)
      );
    }
    addLink("Wikidata", `https://www.wikidata.org/wiki/Q${item.qid}`);
    addLink("OpenStreetMap", `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`);
    addLink("Google Maps", `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`);

    this.body.append(title, meta, figure, extract, facts, links);
    this.panel.classList.add("open");

    if (!item.wiki) return;
    fetch(summaryUrl(item.wikiLang, item.wiki), { signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) {
          extract.textContent = "";
          return;
        }
        extract.textContent = data.extract ?? "";
        if (data.description) meta.textContent += ` · ${data.description}`;
        const thumb = data.thumbnail?.source;
        if (thumb) {
          figure.src = thumb;
          figure.hidden = false;
        }
      })
      .catch((err) => {
        if (err.name !== "AbortError") extract.textContent = "";
      });
  }
}
