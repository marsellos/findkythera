"""Gazetteer sanity: villages.json well-formed, every stem really matches
pages, nothing over-greedy unless flagged, and the precomputed
village_pages.json agrees with the local index.

Run: python -m pytest tests/test_gazetteer.py -v   (from the findkythera folder)
"""

import json
import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
VILLAGES = json.loads((ROOT / "data" / "villages.json").read_text("utf-8"))
PAGES = json.loads((ROOT / "data" / "village_pages.json").read_text("utf-8"))
LOCAL_INDEX = Path(r"C:\ARTI\mpamp\efimerides_ocr\index.db")
TOTAL_PAGES = 17757


# One box per island. A place with no "island" key is on Kythera.
BOXES = {
    "kythera": (36.05, 36.45, 22.85, 23.15),
    "antikythera": (35.80, 35.92, 23.24, 23.38),
}


def test_villages_wellformed():
    ids = [v["id"] for v in VILLAGES]
    assert len(ids) == len(set(ids)), "duplicate village ids"
    for v in VILLAGES:
        lat0, lat1, lon0, lon1 = BOXES[v.get("island", "kythera")]
        assert lat0 <= v["lat"] <= lat1, v["id"]
        assert lon0 <= v["lon"] <= lon1, v["id"]
        assert v["gr"] and v["en"], v["id"]
        assert v["patterns"], v["id"]


def test_no_duplicate_coordinates():
    points = [(v["lat"], v["lon"]) for v in VILLAGES]
    assert len(points) == len(set(points)), "two places share one point"


def test_village_pages_matches_gazetteer():
    assert set(PAGES) == {v["id"] for v in VILLAGES}
    for vid, rows in PAGES.items():
        assert rows, f"{vid} matches zero pages; fix or drop its stem"
        assert rows == sorted(rows), vid
        assert 1 <= rows[0] and rows[-1] <= TOTAL_PAGES, vid


@pytest.mark.skipif(not LOCAL_INDEX.exists(), reason="local index not present")
def test_stems_against_local_index():
    db = sqlite3.connect(LOCAL_INDEX)
    total = db.execute("SELECT count(*) FROM pages").fetchone()[0]
    assert total == TOTAL_PAGES
    for v in VILLAGES:
        expr = " OR ".join(v["patterns"])
        n = db.execute("SELECT count(*) FROM pages WHERE text_norm MATCH ?",
                       (expr,)).fetchone()[0]
        assert n > 0, f"{v['id']}: stem matches nothing"
        if not v.get("ambiguous"):
            assert n <= 0.6 * total, f"{v['id']}: stem too greedy ({n})"
        # The published precompute and the local index must agree exactly.
        assert n == len(PAGES[v["id"]]), (v["id"], n, len(PAGES[v["id"]]))
