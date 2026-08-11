"""Fixture test for build_web_index.py: two tiny fake issues, checks schema, rows,
low_conf flag, papers.json, and chunking."""
import csv
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

TOOL = os.path.join(os.path.dirname(__file__), "..", "..",
                    "efimerides_ocr", "tools", "build_web_index.py")


class BuildWebIndexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self.text_root = os.path.join(root, "text")
        self.out_dir = os.path.join(root, "out")
        os.makedirs(os.path.join(self.text_root, "PAPER_A"))
        os.makedirs(self.out_dir)
        # Two sidecars: one 2-page, one 1-page. \f separates pages.
        with open(os.path.join(self.text_root, "PAPER_A", "a1.txt"), "w",
                  encoding="utf-8") as f:
            f.write("καὶ ο Μαρσέλλος ήρθε\fdeutera selida")
        with open(os.path.join(self.text_root, "PAPER_A", "a2.txt"), "w",
                  encoding="utf-8") as f:
            f.write("mono mia selida")
        self.manifest = os.path.join(root, "MANIFEST.csv")
        with open(self.manifest, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=[
                "relative_path", "newspaper_gr", "newspaper", "year", "issue",
                "filename", "source_url"])
            w.writeheader()
            w.writerow({"relative_path": "PAPER_A/a1.pdf",
                        "newspaper_gr": "Εφημερίς Α",
                        "newspaper": "Paper A", "year": "1997", "issue": "1",
                        "filename": "a1.pdf", "source_url": "http://example/a1"})
            w.writerow({"relative_path": "PAPER_A/a2.pdf",
                        "newspaper_gr": "Εφημερίς Α",
                        "newspaper": "Paper A", "year": "1998", "issue": "2",
                        "filename": "a2.pdf", "source_url": "http://example/a2"})
        self.audit = os.path.join(root, "TEXT_AUDIT.csv")
        with open(self.audit, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["relative_path", "function_share"])
            w.writeheader()
            w.writerow({"relative_path": "PAPER_A/a1.pdf", "function_share": "25.0"})
            w.writerow({"relative_path": "PAPER_A/a2.pdf", "function_share": "3.0"})

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self):
        r = subprocess.run(
            [sys.executable, TOOL, self.manifest, self.text_root, self.audit,
             self.out_dir, "--chunk-bytes", "5000"],
            capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_build(self):
        self.run_tool()
        chunks = sorted(n for n in os.listdir(self.out_dir)
                        if n.startswith("web_index.db."))
        self.assertGreater(len(chunks), 1)          # 5000 rounded down forces >1
        self.assertEqual(chunks[0], "web_index.db.000")
        # 5000 rounds down to 4096 (multiple of the 1024 page size); every chunk
        # but the last must be exactly that size.
        for n in chunks[:-1]:
            self.assertEqual(os.path.getsize(os.path.join(self.out_dir, n)), 4096)
        # Reassemble and inspect.
        db = os.path.join(self.tmp.name, "joined.db")
        with open(db, "wb") as out:
            for n in chunks:
                with open(os.path.join(self.out_dir, n), "rb") as c:
                    out.write(c.read())
        conn = sqlite3.connect(db)
        # Accented text column must be dropped; only the normalized column ships.
        col_names = [r[1] for r in conn.execute("PRAGMA table_info(pages)")]
        self.assertIn("text_norm", col_names)
        self.assertNotIn("text", col_names)
        rows = conn.execute(
            "SELECT newspaper_gr, year, issue, page, low_conf FROM pages "
            "ORDER BY issue, page").fetchall()
        self.assertEqual(len(rows), 3)              # 2 pages + 1 page
        self.assertEqual(rows[0][4], 0)             # share 25 -> not low
        self.assertEqual(rows[2][4], 1)             # share 3  -> low
        # Normalized text matches unaccented.
        hit = conn.execute(
            "SELECT issue, page FROM pages WHERE text_norm MATCH ?",
            ("μαρσελλος",)).fetchall()
        self.assertEqual(hit, [("1", 1)])
        # page_size must be 1024 for sql.js-httpvfs.
        self.assertEqual(conn.execute("PRAGMA page_size").fetchone()[0], 1024)
        conn.close()
        # config.json
        with open(os.path.join(self.out_dir, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["serverMode"], "chunked")
        self.assertEqual(cfg["requestChunkSize"], 1024)
        self.assertEqual(cfg["databaseLengthBytes"], os.path.getsize(db))
        self.assertEqual(cfg["serverChunkSize"], 4096)      # 5000 rounded down
        self.assertEqual(cfg["urlPrefix"], "web_index.db.")
        self.assertEqual(cfg["suffixLength"], 3)
        # papers.json
        with open(os.path.join(self.out_dir, "papers.json"), encoding="utf-8") as f:
            papers = json.load(f)
        self.assertEqual(len(papers), 1)
        self.assertEqual(papers[0]["newspaper"], "Paper A")
        self.assertEqual(papers[0]["year_min"], 1997)
        self.assertEqual(papers[0]["year_max"], 1998)


if __name__ == "__main__":
    unittest.main()
