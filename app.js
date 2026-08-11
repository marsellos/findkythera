// FindKythera: gate, then browser-side FTS5 search via sql.js-httpvfs.
// The database is fetched in 1024-byte pieces over HTTP range requests;
// nothing is downloaded whole and nothing is rehosted.
// lib/index.js is a UMD bundle loaded as a classic script in index.html;
// it puts createDbWorker on window.
const { createDbWorker } = window;

const PASS_SHA256 = "e3a80a83e5cbaeb477754c7e180920a9d343d8325dd4266305852a4b2e3f8b46";
const PAGE_SIZE = 20;

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
async function initGate() {
  if (localStorage.getItem("fk-pass") === PASS_SHA256) {
    return enterApp();
  }
  $("gate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const h = await sha256Hex($("gate-input").value);
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
let current = { fts: "", paper: "", yFrom: null, yTo: null, offset: 0 };

async function enterApp() {
  $("gate").hidden = true;
  $("app").hidden = false;
  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    startSearch();
  });
  $("more").addEventListener("click", () => runSearch(false));
  setStatus("Φόρτωση ευρετηρίου... / Loading the index...");
  try {
    const papers = await (await fetch("data/papers.json")).json();
    for (const p of papers) {
      const o = document.createElement("option");
      o.value = p.newspaper;
      o.textContent = `${p.newspaper_gr} (${p.newspaper})`;
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
  current = {
    fts,
    paper: $("paper-filter").value,
    yFrom: parseInt($("year-from").value, 10) || null,
    yTo: parseInt($("year-to").value, 10) || null,
    offset: 0,
  };
  searchGen++;
  $("results").innerHTML = "";
  $("more").hidden = true;
  runSearch(true);
}

async function runSearch(fresh) {
  const gen = searchGen;
  setStatus("Αναζήτηση... / Searching...");
  $("more").disabled = true;
  $("search-submit").disabled = true;
  try {
    // \x01/\x02 as snippet markers: swapped for <mark> only AFTER HTML-escaping.
    let sql = `SELECT newspaper_gr, newspaper, year, issue, page,
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
    for (const r of rows.slice(0, PAGE_SIZE)) $("results").appendChild(renderRow(r));
    current.offset += PAGE_SIZE;
    $("more").hidden = !hasMore;
    if (fresh && rows.length === 0) {
      setStatus("Καμία σελίδα του αρχείου δεν περιέχει αυτό. / " +
        "No pages in the archive contain this.");
    } else {
      setStatus("");
    }
  } catch (err) {
    if (gen !== searchGen) return;
    console.error(err);
    setStatus("Η αναζήτηση απέτυχε. Δοκιμάστε απλούστερες λέξεις. / " +
      "The search failed. Try plainer words.", true);
  } finally {
    if (gen === searchGen) {
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
    `${r.newspaper_gr} (${r.newspaper}) · τεύχος ${r.issue} · ${r.year} · σελ. ${r.page}`;
  if (r.low_conf) {
    const f = document.createElement("span");
    f.className = "lowconf";
    f.textContent = " [χαμηλή αξιοπιστία κειμένου / low text confidence]";
    cite.appendChild(f);
  }
  const snip = document.createElement("div");
  snip.className = "snip";
  snip.innerHTML = "…" + escapeHtml(r.snip)
    .replaceAll("\u0001", "<mark>").replaceAll("\u0002", "</mark>") + "…";
  const out = document.createElement("div");
  out.className = "out";
  const a = document.createElement("a");
  a.href = r.source_url;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = "Διαβάστε τη σελίδα στο ksa-press.gr → / Read the page at ksa-press.gr →";
  out.appendChild(a);
  li.append(cite, snip, out);
  return li;
}

initGate();
