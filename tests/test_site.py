"""End-to-end test of the FindKythera page against the real chunked database.

Starts serve.py on a spare port, drives the page with Playwright: gate, eye
toggle, search, citation format, link target, filters, favorites, no-results.

The real password is never committed. Search tests bypass the gate by seeding
localStorage with the PASS_SHA256 value read out of app.js, which is exactly
what the app itself stores after a correct entry (a real supported path).
The gate-entry-by-password test runs only when FK_PASSWORD is set.

Run: python -m pytest tests/test_site.py -v   (from the findkythera folder)
"""

import os
import re
import subprocess
import sys
import time
from pathlib import Path

import pytest
from playwright.sync_api import expect, sync_playwright

PORT = 8901
BASE = f"http://127.0.0.1:{PORT}"
PASSWORD = os.environ.get("FK_PASSWORD")

APP_JS = Path(__file__).resolve().parent.parent / "app.js"
PASS_SHA256 = re.search(
    r'PASS_SHA256 = "([0-9a-f]{64})"', APP_JS.read_text(encoding="utf-8")
).group(1)

MARSELLOS = "Μαρσέλλος"  # accented, capitalised
POTAMOS = "ποταμος"
FOUND = "Βρέθηκαν"  # "Βρέθηκαν"


@pytest.fixture(scope="module")
def server():
    proc = subprocess.Popen([sys.executable, "tools/serve.py", str(PORT)])
    time.sleep(2)
    if proc.poll() is not None:
        raise RuntimeError(f"serve.py exited immediately, port {PORT} may be in use")
    yield
    proc.terminate()
    proc.wait(timeout=5)


@pytest.fixture(scope="module")
def browser(server):
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture(scope="module")
def page(browser):
    """Past the gate: localStorage seeded with the stored hash."""
    ctx = browser.new_context()
    ctx.add_init_script(f"window.localStorage.setItem('fk-pass', '{PASS_SHA256}');")
    pg = ctx.new_page()
    pg.goto(BASE)
    expect(pg.locator("#app")).to_be_visible()
    yield pg
    ctx.close()


@pytest.fixture()
def gate_page(browser):
    """Fresh context standing in front of the gate."""
    ctx = browser.new_context()
    pg = ctx.new_page()
    pg.goto(BASE)
    yield pg
    ctx.close()


# ---------- gate ----------

def test_gate_rejects_wrong_password(gate_page):
    gate_page.fill("#gate-input", "wrong")
    gate_page.click("#gate-form button[type=submit]")
    expect(gate_page.locator("#gate-error")).to_be_visible()
    expect(gate_page.locator("#app")).to_be_hidden()
    # Typing again hides the stale error.
    gate_page.fill("#gate-input", "wrong2")
    expect(gate_page.locator("#gate-error")).to_be_hidden()


def test_gate_eye_toggles_visibility(gate_page):
    gate_page.fill("#gate-input", "abc")
    assert gate_page.get_attribute("#gate-input", "type") == "password"
    gate_page.click("#gate-eye")
    assert gate_page.get_attribute("#gate-input", "type") == "text"
    assert gate_page.get_attribute("#gate-eye", "aria-pressed") == "true"
    gate_page.click("#gate-eye")
    assert gate_page.get_attribute("#gate-input", "type") == "password"
    assert gate_page.get_attribute("#gate-eye", "aria-pressed") == "false"


@pytest.mark.skipif(not PASSWORD, reason="FK_PASSWORD not set")
def test_gate_accepts_password(gate_page):
    gate_page.fill("#gate-input", PASSWORD)
    gate_page.click("#gate-form button[type=submit]")
    expect(gate_page.locator("#app")).to_be_visible()


# ---------- search ----------

def test_search_works_citation_clean_link_paged(page):
    # Index loads: dropdown fills (19 papers + "all").
    expect(page.locator("#paper-filter option")).to_have_count(20, timeout=30000)
    page.fill("#q", MARSELLOS)
    page.click("#search-submit")
    first = page.locator("#results li").first
    expect(first).to_be_visible(timeout=30000)
    # Citation-first: bold line carries paper - issue - year - page.
    cite = first.locator(".cite").inner_text()
    assert re.search(r"τεύχος .+ · \d{4} · σελ\. \d+", cite)
    # No internal folder slug in the citation.
    assert not re.search(r"[A-Z_]{4,}", cite)
    # Snippet highlights the match and never opens with a double ellipsis.
    expect(first.locator(".snip mark").first).to_be_visible()
    snip = first.locator(".snip").inner_text()
    assert not re.match(r"…\s*…", snip)
    # Link goes out to ksa-press.gr, over https, landing on the cited page.
    href = first.locator(".out a").get_attribute("href")
    assert href.startswith("https://")
    assert "ksa-press.gr" in href
    assert re.search(r"#page=\d+$", href)
    # Success is announced with a count.
    expect(page.locator("#status")).to_contain_text(FOUND)


def test_no_results_message(page):
    page.fill("#q", "zzzzzqqqqq")
    page.click("#search-submit")
    expect(page.locator("#status")).to_contain_text(
        "No pages in the archive contain this", timeout=30000)


def test_year_filter_narrows(page):
    page.fill("#q", POTAMOS)
    page.fill("#year-from", "1997")
    page.fill("#year-to", "1997")
    page.click("#search-submit")
    first = page.locator("#results li").first
    expect(first).to_be_visible(timeout=60000)
    # Safe from a vacuous pass: the to_be_visible wait above guarantees at least one
    # row, and app.js renders a whole result batch synchronously, so every row of the
    # batch is in the DOM once the first is visible.
    for cite in page.locator("#results .cite").all_inner_texts():
        assert "1997" in cite


def test_reversed_year_range_completes(page):
    # Regression: 1997-1893 used to build an unsatisfiable WHERE and hang for
    # minutes. The range is now swapped, so this must complete like any search.
    page.fill("#q", POTAMOS)
    page.fill("#year-from", "1997")
    page.fill("#year-to", "1893")
    page.click("#search-submit")
    expect(page.locator("#results li").first).to_be_visible(timeout=60000)
    expect(page.locator("#status")).to_contain_text(FOUND, timeout=60000)


def test_invalid_year_refused(page):
    page.fill("#q", POTAMOS)
    page.fill("#year-from", "97")
    page.fill("#year-to", "")
    page.click("#search-submit")
    expect(page.locator("#status")).to_contain_text("Valid years", timeout=5000)
    page.fill("#year-from", "")


def test_more_button_paginates_without_duplicates(page):
    page.fill("#q", MARSELLOS)
    page.fill("#year-from", "")
    page.fill("#year-to", "")
    page.click("#search-submit")
    expect(page.locator("#results li")).to_have_count(20, timeout=30000)
    page.click("#more")
    expect(page.locator("#results li")).to_have_count(40, timeout=30000)
    cites = page.locator("#results .cite").all_inner_texts()
    snips = page.locator("#results .snip").all_inner_texts()
    pairs = list(zip(cites, snips))
    assert len(pairs) == 40
    assert len(set(pairs)) == 40


# ---------- favorites ----------

def test_favorites_save_list_remove(page):
    page.fill("#q", MARSELLOS)
    page.click("#search-submit")
    first = page.locator("#results li").first
    expect(first).to_be_visible(timeout=30000)
    star = first.locator(".fav-btn")
    star.click()
    expect(star).to_have_class(re.compile(r"\bsaved\b"))
    expect(page.locator("#favs-btn")).to_contain_text("(1)")
    # The favorites view lists the saved page with its link intact.
    page.click("#favs-btn")
    expect(page.locator("#results li")).to_have_count(1)
    href = page.locator("#results .out a").get_attribute("href")
    assert "ksa-press.gr" in href and "#page=" in href
    # Remove empties the list and the counter.
    page.locator("#results .fav-btn").click()
    expect(page.locator("#results li")).to_have_count(0)
    expect(page.locator("#favs-btn")).to_contain_text("(0)")


# ---------- village map ----------

def test_map_draws_markers_and_panel(page):
    page.fill("#q", MARSELLOS)
    page.fill("#year-from", "")
    page.fill("#year-to", "")
    page.click("#search-submit")
    expect(page.locator("#results li").first).to_be_visible(timeout=60000)
    page.click("#map-btn")
    expect(page.locator("#map-view")).to_be_visible()
    # The rowids query runs, then circles appear: every village drawn, at
    # least one co-occurring with the surname.
    expect(page.locator("path.vc-hit").first).to_be_visible(timeout=120000)
    # Two frames, each fitted to its own island: 72 places on Kythera and
    # 7 on Antikythera, and no place drawn in the wrong frame.
    assert page.locator("#map path.vc").count() == 72
    assert page.locator("#map-ak path.vc").count() == 7
    expect(page.locator("#map-ak")).to_be_visible()
    expect(page.locator(".map-frame-inset")).to_contain_text("Αντικύθηρα")
    expect(page.locator(".frame-scale")).to_contain_text("άλλη κλίμακα")
    # The map replaces the results list.
    expect(page.locator("#results li")).to_have_count(0)
    # Clicking a village opens the panel with the honest same-page count,
    # then the live NEAR refinement and a list linking out to ksa-press.gr.
    page.locator("path.vc-hit").first.dispatch_event("click")
    expect(page.locator("#map-panel")).to_be_visible()
    expect(page.locator("#map-panel")).to_contain_text("Στην ίδια σελίδα")
    expect(page.locator("#map-panel")).to_contain_text("15 λέξεων",
                                                       timeout=120000)
    first_link = page.locator("#map-panel .out a").first
    expect(first_link).to_be_visible(timeout=120000)
    href = first_link.get_attribute("href")
    assert "ksa-press.gr" in href and "#page=" in href


def test_map_leaves_on_new_search(page):
    page.click("#search-submit")  # same term again
    expect(page.locator("#map-view")).to_be_hidden()
    expect(page.locator("#results li").first).to_be_visible(timeout=60000)
