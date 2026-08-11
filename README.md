# FindKythera

Search site over the Kytherian newspaper archive index (17,757 pages, 2,278 issues,
1893 to the 2000s). Static: the whole search runs in the visitor's browser against a
chunked SQLite database served as plain files. Nothing is rehosted; every result links
out to www.ksa-press.gr.

Design: `..\efimerides\FINDKYTHERA-DESIGN.md`. Build: `..\efimerides\FINDKYTHERA-PLAN.md`.

## Local run

    python tools/serve.py 8000

then open http://localhost:8000. A plain `python -m http.server` will NOT work: the
database is fetched with HTTP range requests, which that server does not support.

## Rebuild the database (after the sidecars change)

    python ../efimerides_ocr/tools/build_web_index.py ../efimerides/MANIFEST.csv ../efimerides_ocr/text ../efimerides/TEXT_AUDIT.csv data

The chunks in data/ are committed as plain files on purpose: GitHub Pages does not
serve Git LFS files, so each chunk stays under GitHub's 100 MB plain-file limit instead.

## Deploy

NOT YET. Deploying to marsellos.github.io/findkythera needs Dr. M's explicit go-ahead.
