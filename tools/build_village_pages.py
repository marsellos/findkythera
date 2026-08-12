"""Precompute data/village_pages.json from the published DB chunks.

For each village in data/villages.json, store the sorted rowids of every
page matching its patterns. Rowids MUST align with what the site queries,
so this script reads the REASSEMBLED web chunks (data/web_index.db.*),
never the local efimerides_ocr index.

Run from the repo root after any change to data/villages.json:

    python tools/build_village_pages.py

Pass a path to an already-reassembled DB to skip the reassembly:

    python tools/build_village_pages.py path\\to\\web_full.db
"""
import glob
import json
import os
import sqlite3
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")


def reassemble(tmpdir):
    chunks = sorted(glob.glob(os.path.join(DATA, "web_index.db.*")))
    if not chunks:
        sys.exit("no data/web_index.db.* chunks found")
    path = os.path.join(tmpdir, "web_full.db")
    with open(path, "wb") as out:
        for c in chunks:
            with open(c, "rb") as f:
                out.write(f.read())
    return path


def main():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = sys.argv[1] if len(sys.argv) > 1 else reassemble(tmpdir)
        db = sqlite3.connect(db_path)
        villages = json.load(
            open(os.path.join(DATA, "villages.json"), encoding="utf-8"))
        out = {}
        for v in villages:
            expr = " OR ".join(v["patterns"])
            rows = db.execute(
                "SELECT rowid FROM pages WHERE text_norm MATCH ? "
                "ORDER BY rowid",
                (expr,)).fetchall()
            out[v["id"]] = [r[0] for r in rows]
            print(f"{len(out[v['id']]):6d}  {v['gr']}")
        db.close()
    dest = os.path.join(DATA, "village_pages.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"\nwrote {dest} ({os.path.getsize(dest):,} bytes, "
          f"{len(out)} villages)")


if __name__ == "__main__":
    main()
