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
let current = { fts: "", paper: "", yFrom: null, yTo: null, offset: 0, loaded: 0 };
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
    paper: $("paper-filter").value,
    yFrom,
    yTo,
    offset: 0,
    loaded: 0,
  };
  searchGen++;
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

initGate();
