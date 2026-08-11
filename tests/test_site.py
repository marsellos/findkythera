import re
import subprocess
import sys
import time

import pytest
from playwright.sync_api import expect, sync_playwright

PORT = 8901
BASE = f"http://127.0.0.1:{PORT}"


@pytest.fixture(scope="module")
def server():
    proc = subprocess.Popen([sys.executable, "tools/serve.py", str(PORT)])
    time.sleep(2)
    yield
    proc.terminate()


@pytest.fixture(scope="module")
def page(server):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page()
        yield pg
        browser.close()


def test_gate_rejects_wrong_password(page):
    page.goto(BASE)
    page.fill("#gate-input", "wrong")
    page.click("#gate-form button")
    expect(page.locator("#gate-error")).to_be_visible()
    expect(page.locator("#app")).to_be_hidden()


def test_gate_accepts_and_search_works(page):
    page.fill("#gate-input", "kythera")
    page.click("#gate-form button")
    expect(page.locator("#app")).to_be_visible()
    # Index loads: status clears and dropdown fills.
    expect(page.locator("#paper-filter option")).to_have_count(20, timeout=30000)  # 19 + "all"
    page.fill("#q", "\u039c\u03b1\u03c1\u03c3\u03ad\u03bb\u03bb\u03bf\u03c2")   # accented, capitalised
    page.click("#search-form button")
    first = page.locator("#results li").first
    expect(first).to_be_visible(timeout=30000)
    # Citation-first: bold line carries paper - issue - year - page.
    cite = first.locator(".cite").inner_text()
    assert re.search(r"\u03c4\u03b5\u03cd\u03c7\u03bf\u03c2 .+ \u00b7 \d{4} \u00b7 \u03c3\u03b5\u03bb\. \d+", cite)
    # Snippet highlights the match, link goes out to ksa-press.gr.
    expect(first.locator(".snip mark").first).to_be_visible()
    href = first.locator(".out a").get_attribute("href")
    assert "ksa-press.gr" in href


def test_no_results_message(page):
    page.fill("#q", "zzzzzqqqqq")
    page.click("#search-form button")
    expect(page.locator("#status")).to_contain_text(
        "No pages in the archive contain this", timeout=30000)


def test_year_filter_narrows(page):
    page.fill("#q", "\u03c0\u03bf\u03c4\u03b1\u03bc\u03bf\u03c2")
    page.fill("#year-from", "1997")
    page.fill("#year-to", "1997")
    page.click("#search-form button")
    first = page.locator("#results li").first
    expect(first).to_be_visible(timeout=60000)
    for cite in page.locator("#results .cite").all_inner_texts():
        assert "1997" in cite
