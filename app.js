// FindKythera: gate, then browser-side FTS5 search via sql.js-httpvfs.
// The database is fetched in 1024-byte pieces over HTTP range requests;
// nothing is downloaded whole and nothing is rehosted.
// lib/index.js is a UMD bundle loaded as a classic script in index.html;
// it puts createDbWorker on window.
const { createDbWorker } = window;

const PASS_SHA256 = "9c164b96ea0bb8f6a3e38d69db4a6c0d8384759e2b36e8ab6dde876c1b61fd51";
const PAGE_SIZE = 20;
const YEAR_MIN = 1893;
const YEAR_MAX = 2010;
const FAVS_KEY = "fk-favs";

const $ = (id) => document.getElementById(id);

// Must match unaccent() in build_index.py / search.py: NFD, lowercase,
// strip combining marks.
function unaccent(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// FTS5 query: each whitespace-separated term quoted (implicit AND), so user
// punctuation cannot become FTS syntax.
function ftsQuery(input) {
  return input.trim().split(/\s+/).filter(Boolean)
    .map((t) => '"' + t.replace(/"/g, "") + '"').join(" ");
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- gate ----------
const EYE_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  + ' aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1'
  + ' 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  + ' aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1'
  + ' 12z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="3" x2="21"'
  + ' y2="21"/></svg>';

async function initGate() {
  if (localStorage.getItem("fk-pass") === PASS_SHA256) {
    return enterApp();
  }
  const input = $("gate-input");
  const eye = $("gate-eye");
  eye.innerHTML = EYE_OPEN; // static markup above, nothing user-supplied
  input.focus();
  input.addEventListener("input", () => { $("gate-error").hidden = true; });
  eye.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    eye.innerHTML = show ? EYE_OFF : EYE_OPEN;
    eye.setAttribute("aria-pressed", String(show));
    eye.setAttribute("aria-label", show
      ? "Απόκρυψη κωδικού / Hide password"
      : "Εμφάνιση κωδικού / Show password");
    input.focus();
  });
  $("gate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const h = await sha256Hex(input.value);
    if (h === PASS_SHA256) {
      localStorage.setItem("fk-pass", h);
      enterApp();
    } else {
      $("gate-error").hidden = false;
    }
  });
}

// ---------- app ----------
let worker = null;
let pendingSearch = false;
let loadFailed = false;
let searchGen = 0;
let statusTimer = null;
let current = { fts: "", raw: "", paper: "", yFrom: null, yTo: null, offset: 0, loaded: 0 };
let favs = loadFavs();

async function enterApp() {
  $("gate").hidden = true;
  $("app").hidden = false;
  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    startSearch();
  });
  $("more").addEventListener("click", () => runSearch(false));
  $("favs-btn").addEventListener("click", showFavs);
  $("map-btn").addEventListener("click", showMap);
  updateFavsButton();
  setStatus("Φόρτωση ευρετηρίου... / Loading the index...");
  try {
    const papers = await (await fetch("data/papers.json")).json();
    for (const p of papers) {
      const o = document.createElement("option");
      o.value = p.newspaper;
      o.textContent = p.newspaper_gr;
      $("paper-filter").appendChild(o);
    }
    worker = await createDbWorker(
      [{ from: "jsonconfig", configUrl: new URL("data/config.json", location.href).toString() }],
      new URL("lib/sqlite.worker.js", location.href).toString(),
      new URL("lib/sql-wasm.wasm", location.href).toString(),
    );
    setStatus("");
    if (pendingSearch) {
      pendingSearch = false;
      startSearch();
    }
  } catch (err) {
    loadFailed = true;
    setStatus("Το ευρετήριο δεν φορτώθηκε. Δοκιμάστε ξανά αργότερα. / " +
      "The index failed to load. Try again later.", true);
    console.error(err);
    return;
  }
}

function setStatus(msg, isError) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
}

// The elapsed-seconds ticker: a long query must never look frozen.
function startTicker() {
  stopTicker();
  const t0 = Date.now();
  setStatus("Αναζήτηση... / Searching...");
  statusTimer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    let msg = `Αναζήτηση (${s}s)... / Searching (${s}s)...`;
    if (s >= 5) {
      msg += " Οι κοινές λέξεις μπορεί να χρειαστούν έως δύο λεπτά. / " +
        "Common words can take up to two minutes.";
    }
    setStatus(msg);
  }, 1000);
}

function stopTicker() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

// Empty box: null. Anything not a year in 1893-2010: NaN (refused).
function readYear(id) {
  const raw = $(id).value.trim();
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return (Number.isNaN(n) || n < YEAR_MIN || n > YEAR_MAX) ? NaN : n;
}

function startSearch() {
  const fts = ftsQuery(unaccent($("q").value));
  if (!fts) return;
  if (!worker) {
    if (loadFailed) {
      setStatus("Το ευρετήριο δεν φορτώθηκε. Δοκιμάστε ξανά αργότερα. / " +
        "The index failed to load. Try again later.", true);
      return;
    }
    pendingSearch = true;
    setStatus("Το ευρετήριο φορτώνει ακόμη... / The index is still loading...");
    return;
  }
  let yFrom = readYear("year-from");
  let yTo = readYear("year-to");
  if (Number.isNaN(yFrom) || Number.isNaN(yTo)) {
    setStatus(`Έγκυρα έτη: ${YEAR_MIN} έως ${YEAR_MAX}. / ` +
      `Valid years: ${YEAR_MIN} to ${YEAR_MAX}.`, true);
    return;
  }
  if (yFrom !== null && yTo !== null && yFrom > yTo) {
    [yFrom, yTo] = [yTo, yFrom]; // a reversed range means the same range
  }
  current = {
    fts,
    raw: $("q").value.trim(),
    paper: $("paper-filter").value,
    yFrom,
    yTo,
    offset: 0,
    loaded: 0,
  };
  searchGen++;
  hideMap();
  $("results").innerHTML = "";
  $("more").hidden = true;
  runSearch(true);
}

async function runSearch(fresh) {
  const gen = searchGen;
  startTicker();
  $("more").disabled = true;
  $("search-submit").disabled = true;
  try {
    // \x01/\x02 as snippet markers: swapped for <mark> only AFTER HTML-escaping.
    let sql = `SELECT newspaper_gr, newspaper, year, issue, page, filename,
        snippet(pages, 6, char(1), char(2), ' … ', 12) AS snip,
        source_url, low_conf
      FROM pages WHERE text_norm MATCH ?`;
    const params = [current.fts];
    if (current.paper) { sql += " AND newspaper = ?"; params.push(current.paper); }
    if (current.yFrom) { sql += " AND CAST(year AS INTEGER) >= ?"; params.push(current.yFrom); }
    if (current.yTo)   { sql += " AND CAST(year AS INTEGER) <= ?"; params.push(current.yTo); }
    sql += " ORDER BY rank LIMIT ? OFFSET ?";
    params.push(PAGE_SIZE + 1, current.offset);
    const rows = await worker.db.query(sql, params);
    if (gen !== searchGen) return; // a newer search superseded this one
    const hasMore = rows.length > PAGE_SIZE;
    const batch = rows.slice(0, PAGE_SIZE);
    for (const r of batch) $("results").appendChild(renderRow(r));
    current.offset += PAGE_SIZE;
    current.loaded += batch.length;
    $("more").hidden = !hasMore;
    stopTicker();
    if (fresh && rows.length === 0) {
      setStatus("Καμία σελίδα του αρχείου δεν περιέχει αυτό. / " +
        "No pages in the archive contain this.");
    } else if (hasMore) {
      setStatus(`Βρέθηκαν τουλάχιστον ${current.loaded} σελίδες. / ` +
        `At least ${current.loaded} pages found.`);
    } else {
      setStatus(`Βρέθηκαν ${current.loaded} σελίδες. Αυτά είναι όλα. / ` +
        `${current.loaded} pages found. That is all.`);
    }
  } catch (err) {
    if (gen !== searchGen) return;
    console.error(err);
    stopTicker();
    const network = !navigator.onLine ||
      /fetch|network|http|connection/i.test(String(err && err.message));
    setStatus(network
      ? "Η σύνδεση διακόπηκε. Ελέγξτε το δίκτυο και δοκιμάστε ξανά. / " +
        "The connection was interrupted. Check your network and try again."
      : "Η αναζήτηση απέτυχε. Δοκιμάστε απλούστερες λέξεις. / " +
        "The search failed. Try plainer words.", true);
  } finally {
    if (gen === searchGen) {
      stopTicker();
      $("more").disabled = false;
      $("search-submit").disabled = false;
    }
  }
}

const escapeHtml = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderRow(r) {
  const li = document.createElement("li");
  const cite = document.createElement("div");
  cite.className = "cite";
  cite.textContent =
    `${r.newspaper_gr} · τεύχος ${r.issue} · ${r.year} · σελ. ${r.page}`;
  if (r.low_conf) {
    const f = document.createElement("span");
    f.className = "lowconf";
    f.textContent = " [χαμηλή αξιοπιστία κειμένου / low text confidence]";
    cite.appendChild(f);
  }
  // FTS5's snippet() already prints " … " at truncated edges; strip those
  // before wrapping once, so results never open with "… …".
  const disp = String(r.snip ?? "").replace(/^[\s…]+/, "").replace(/[\s…]+$/, "");
  const snip = document.createElement("div");
  snip.className = "snip";
  snip.innerHTML = "… " + escapeHtml(disp)
    .replaceAll("\u0001", "<mark>").replaceAll("\u0002", "</mark>") + " …";
  // Serve the link over https and land the reader on the cited page.
  const link = String(r.source_url).replace(/^http:/, "https:") + "#page=" + r.page;
  const out = document.createElement("div");
  out.className = "out";
  const a = document.createElement("a");
  a.href = link;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = "Διαβάστε τη σελίδα στο ksa-press.gr → / Read the page at ksa-press.gr →";
  const star = document.createElement("button");
  star.type = "button";
  star.className = "fav-btn";
  const key = `${r.filename}|${r.page}`;
  const paint = () => {
    const saved = Object.prototype.hasOwnProperty.call(favs, key);
    star.textContent = saved
      ? "★ Αποθηκευμένο / Saved" : "☆ Αποθήκευση / Save";
    star.classList.toggle("saved", saved);
  };
  star.addEventListener("click", () => {
    if (Object.prototype.hasOwnProperty.call(favs, key)) {
      delete favs[key];
    } else {
      favs[key] = {
        key,
        newspaper_gr: r.newspaper_gr,
        issue: r.issue,
        year: r.year,
        page: r.page,
        snip: disp.replaceAll("\u0001", "").replaceAll("\u0002", ""),
        url: link,
      };
    }
    saveFavs();
    paint();
    updateFavsButton();
  });
  paint();
  out.append(a, star);
  li.append(cite, snip, out);
  return li;
}

// ---------- favorites (this browser only; localStorage, no account) ----------
function loadFavs() {
  try { return JSON.parse(localStorage.getItem(FAVS_KEY)) || {}; }
  catch { return {}; }
}

function saveFavs() {
  try { localStorage.setItem(FAVS_KEY, JSON.stringify(favs)); } catch { /* full or blocked: keep in-memory */ }
}

function updateFavsButton() {
  const n = Object.keys(favs).length;
  const b = $("favs-btn");
  b.textContent = `★ Αποθηκευμένα / Saved (${n})`;
  b.classList.toggle("has-favs", n > 0);
}

function favsStatus(n) {
  return `Οι αποθηκευμένες σας σελίδες: ${n}. Κάντε νέα αναζήτηση για να επιστρέψετε. / ` +
    `Your saved pages: ${n}. Run a new search to return.`;
}

function showFavs() {
  searchGen++; // supersede any running search
  hideMap();
  stopTicker();
  $("more").hidden = true;
  $("more").disabled = false;
  $("search-submit").disabled = false;
  $("results").innerHTML = "";
  const list = Object.values(favs);
  if (!list.length) {
    setStatus("Δεν έχετε αποθηκευμένες σελίδες ακόμη. Πατήστε «Αποθήκευση» σε ένα αποτέλεσμα. / " +
      "No saved pages yet. Press Save on a result.");
    return;
  }
  setStatus(favsStatus(list.length));
  for (const f of list) $("results").appendChild(renderFavRow(f));
}

function renderFavRow(f) {
  const li = document.createElement("li");
  const cite = document.createElement("div");
  cite.className = "cite";
  cite.textContent =
    `${f.newspaper_gr} · τεύχος ${f.issue} · ${f.year} · σελ. ${f.page}`;
  const snip = document.createElement("div");
  snip.className = "snip";
  snip.textContent = f.snip ? `… ${f.snip} …` : "";
  const out = document.createElement("div");
  out.className = "out";
  const a = document.createElement("a");
  a.href = f.url;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = "Διαβάστε τη σελίδα στο ksa-press.gr → / Read the page at ksa-press.gr →";
  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "fav-btn";
  rm.textContent = "Αφαίρεση / Remove";
  rm.addEventListener("click", () => {
    delete favs[f.key];
    saveFavs();
    li.remove();
    updateFavsButton();
    const n = Object.keys(favs).length;
    setStatus(n ? favsStatus(n)
      : "Δεν έχετε αποθηκευμένες σελίδες. / No saved pages.");
  });
  out.append(a, rm);
  li.append(cite, snip, out);
  return li;
}

// ---------- village map ----------
// Search a term, press Map: Kythera appears with a circle on each village,
// sized by how many pages report the term together with that village on the
// same page (precomputed data/village_pages.json intersected with one
// rowids-only query). Clicking a village runs ONE live NEAR(term stem, 15)
// query for that village only. Leaflet is vendored; no tile servers, no
// external requests.
// Antikythera lies about 38 km south, so it gets its own frame beside Kythera
// rather than one shared view that would shrink both islands to specks.
let mapData = null;      // { villages, pages, outline, outlineAk } once fetched
let leafletMap = null;   // Kythera
let leafletMapAk = null; // Antikythera
let markersLayer = null;
let markersLayerAk = null;
let rowidCache = { sig: "", set: null };
let mapGen = 0;          // supersedes map draws
let panelGen = 0;        // supersedes village panel queries

function hideMap() {
  mapGen++;
  panelGen++;
  $("map-view").hidden = true;
  $("map-panel").hidden = true;
}

// SQL filter clauses matching runSearch, so the map honors paper/year filters.
function filterSql(params) {
  let sql = "";
  if (current.paper) { sql += " AND newspaper = ?"; params.push(current.paper); }
  if (current.yFrom) { sql += " AND CAST(year AS INTEGER) >= ?"; params.push(current.yFrom); }
  if (current.yTo)   { sql += " AND CAST(year AS INTEGER) <= ?"; params.push(current.yTo); }
  return sql;
}

async function showMap() {
  if (!current.fts) {
    setStatus("Κάντε πρώτα μια αναζήτηση, μετά ανοίξτε τον χάρτη. / " +
      "Run a search first, then open the map.");
    return;
  }
  if (!worker) {
    setStatus("Το ευρετήριο φορτώνει ακόμη... / The index is still loading...");
    return;
  }
  searchGen++; // supersede any running list search
  panelGen++;
  stopTicker();
  $("results").innerHTML = "";
  $("more").hidden = true;
  $("more").disabled = false;
  $("search-submit").disabled = false;
  $("map-heading").textContent =
    `Πού αναφέρεται μαζί: «${current.raw}» / Where "${current.raw}" is reported together`;
  $("map-view").hidden = false;
  $("map-panel").hidden = true;
  const gen = ++mapGen;
  try {
    if (!mapData) {
      setStatus("Φόρτωση χάρτη... / Loading the map...");
      const [villages, pages, outline, outlineAk] = await Promise.all([
        fetch("data/villages.json").then((r) => r.json()),
        fetch("data/village_pages.json").then((r) => r.json()),
        fetch("data/kythera_outline.json").then((r) => r.json()),
        fetch("data/antikythera_outline.json").then((r) => r.json()),
      ]);
      if (gen !== mapGen) return;
      mapData = { villages, pages, outline, outlineAk };
    }
    const sig = JSON.stringify(
      [current.fts, current.paper, current.yFrom, current.yTo]);
    if (rowidCache.sig !== sig) {
      startTicker();
      const params = [current.fts];
      const sql = "SELECT rowid AS r FROM pages WHERE text_norm MATCH ?"
        + filterSql(params);
      const rows = await worker.db.query(sql, params);
      if (gen !== mapGen) return;
      rowidCache = { sig, set: new Set(rows.map((x) => x.r)) };
    }
    stopTicker();
    drawMap();
  } catch (err) {
    if (gen !== mapGen) return;
    console.error(err);
    stopTicker();
    setStatus("Ο χάρτης δεν φορτώθηκε. Δοκιμάστε ξανά. / " +
      "The map failed to load. Try again.", true);
  }
}

function villageCount(v) {
  const set = rowidCache.set;
  let n = 0;
  for (const r of mapData.pages[v.id] || []) if (set.has(r)) n++;
  return n;
}

function makeFrame(divId, geojson) {
  const map = L.map(divId, { attributionControl: false, zoomSnap: 0.25 });
  const outline = L.geoJSON(geojson, {
    style: { color: "#8a8a8f", weight: 1, fillColor: "#f7f3ea", fillOpacity: 1 },
  }).addTo(map);
  map.fitBounds(outline.getBounds().pad(0.04));
  return { map, layer: L.layerGroup().addTo(map) };
}

function initLeaflet() {
  const k = makeFrame("map", mapData.outline);
  leafletMap = k.map;
  markersLayer = k.layer;
  const a = makeFrame("map-ak", mapData.outlineAk);
  leafletMapAk = a.map;
  markersLayerAk = a.layer;
}

function drawMap() {
  if (!leafletMap) initLeaflet();
  leafletMap.invalidateSize();
  leafletMapAk.invalidateSize();
  markersLayer.clearLayers();
  markersLayerAk.clearLayers();
  const counts = mapData.villages.map((v) => ({ v, n: villageCount(v) }));
  // The two frames are at different scales, so a circle is sized against the
  // busiest place on its own island. Comparing across the frames by eye would
  // be wrong either way.
  const maxK = Math.max(1, ...counts.filter((c) => c.v.island !== "antikythera")
    .map((c) => c.n));
  const maxA = Math.max(1, ...counts.filter((c) => c.v.island === "antikythera")
    .map((c) => c.n));
  let hitVillages = 0;
  for (const { v, n } of counts) {
    if (n > 0) hitVillages++;
    const onAk = v.island === "antikythera";
    const maxN = onAk ? maxA : maxK;
    const marker = L.circleMarker([v.lat, v.lon], n > 0 ? {
      radius: 4 + 14 * Math.sqrt(n / maxN),
      className: "vc vc-hit",
      color: "#fff", weight: 1,
      fillColor: "#0b5394", fillOpacity: 0.55,
    } : {
      radius: 2.5,
      className: "vc vc-zero",
      color: "#9aa0a6", weight: 1,
      fillColor: "#9aa0a6", fillOpacity: 0.6,
    });
    // The Antikythera frame is narrow, so its labels sit above the circle and
    // wrap, instead of running off the side of the frame and being cut.
    marker.bindTooltip(`${v.gr} / ${v.en}: ${n}`,
      onAk ? { direction: "top" } : {});
    marker.on("click", () => openVillagePanel(v, n));
    (onAk ? markersLayerAk : markersLayer).addLayer(marker);
  }
  setStatus(`Ο όρος αναφέρεται μαζί με ${hitVillages} από τα ${counts.length} ` +
    `μέρη. Πατήστε έναν κύκλο. / The term is reported together with ` +
    `${hitVillages} of the ${counts.length} places. Press a circle.`);
}

async function openVillagePanel(v, sameCount) {
  const gen = ++panelGen;
  const panel = $("map-panel");
  panel.innerHTML = "";
  panel.hidden = false;
  const h = document.createElement("h3");
  h.textContent = `${v.gr} / ${v.en}`;
  panel.appendChild(h);
  const same = document.createElement("p");
  same.textContent = `Στην ίδια σελίδα με «${current.raw}»: ${sameCount} ` +
    `σελίδες. / On the same page as "${current.raw}": ${sameCount} pages.`;
  panel.appendChild(same);
  if (v.note_gr || v.note_en) {
    const note = document.createElement("p");
    note.className = "map-note";
    note.textContent = `Σημείωση: ${v.note_gr || ""} / Note: ${v.note_en || ""}`;
    panel.appendChild(note);
  }
  if (v.ambiguous) {
    const amb = document.createElement("p");
    amb.className = "map-note";
    amb.textContent = "Το όνομα είναι και κοινή λέξη, οι αριθμοί βγαίνουν " +
      "μεγάλοι. / The name is also a common word, so the counts run high.";
    panel.appendChild(amb);
  }
  if (sameCount === 0) {
    const none = document.createElement("p");
    none.textContent = "Καμία κοινή σελίδα. / No shared pages.";
    panel.appendChild(none);
    return;
  }
  const near = document.createElement("p");
  near.textContent = "Μέτρηση σε απόσταση 15 λέξεων... / " +
    "Counting within 15 words...";
  panel.appendChild(near);
  const nearExpr = v.patterns
    .map((p) => `NEAR(${current.fts} ${p}, 15)`).join(" OR ");
  try {
    const params = [nearExpr];
    const sql = "SELECT count(*) AS n FROM pages WHERE text_norm MATCH ?"
      + filterSql(params);
    const nearCount = (await worker.db.query(sql, params))[0].n;
    if (gen !== panelGen) return;
    near.textContent = `Σε απόσταση έως 15 λέξεων: ${nearCount} σελίδες. / ` +
      `Within 15 words of each other: ${nearCount} pages.`;
    // List the closest evidence there is: NEAR pages when any exist,
    // otherwise the same-page matches.
    const sameExpr = `(${current.fts}) AND (${v.patterns.join(" OR ")})`;
    const listExpr = nearCount > 0 ? nearExpr : sameExpr;
    const label = document.createElement("p");
    label.className = "map-note";
    label.textContent = nearCount > 0
      ? "Σελίδες όπου γράφονται κοντά: / Pages where they are written close together:"
      : "Σελίδες όπου γράφονται στην ίδια σελίδα: / Pages where they appear on the same page:";
    panel.appendChild(label);
    const ol = document.createElement("ol");
    panel.appendChild(ol);
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "panel-more";
    moreBtn.textContent = "Περισσότερα / More";
    moreBtn.hidden = true;
    panel.appendChild(moreBtn);
    let offset = 0;
    const loadPages = async () => {
      moreBtn.disabled = true;
      const p2 = [listExpr];
      let sql2 = `SELECT newspaper_gr, newspaper, year, issue, page, filename,
          snippet(pages, 6, char(1), char(2), ' … ', 12) AS snip,
          source_url, low_conf
        FROM pages WHERE text_norm MATCH ?` + filterSql(p2);
      sql2 += " ORDER BY rank LIMIT ? OFFSET ?";
      p2.push(PAGE_SIZE + 1, offset);
      const rows = await worker.db.query(sql2, p2);
      if (gen !== panelGen) return;
      for (const r of rows.slice(0, PAGE_SIZE)) ol.appendChild(renderRow(r));
      offset += PAGE_SIZE;
      moreBtn.hidden = rows.length <= PAGE_SIZE;
      moreBtn.disabled = false;
    };
    moreBtn.addEventListener("click", loadPages);
    await loadPages();
  } catch (err) {
    if (gen !== panelGen) return;
    console.error(err);
    near.textContent = "Η μέτρηση απέτυχε. Δοκιμάστε ξανά. / " +
      "The count failed. Try again.";
  }
}

initGate();
