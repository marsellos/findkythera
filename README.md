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

After any rebuild, verify parity with the local index:

    python ../efimerides_ocr/tools/check_web_index.py ../efimerides_ocr/index.db data

## Deploy

NOT YET. Deploying to marsellos.github.io/findkythera needs Dr. M's explicit go-ahead.

Before going live, replace the dev password. Generate the hash with:

    python -c "import hashlib; print(hashlib.sha256('THE-REAL-PASSWORD'.encode()).hexdigest())"

then paste the result into the `PASS_SHA256` constant near the top of `app.js`.
The hash committed in this repo is the dev password only.

Warning: every data rebuild rewrites all six chunk files (about 470 MB), and git
keeps every generation in history forever, so a few rebuilds after publishing will
push the repo past GitHub's 1 GB comfort zone. Decide a strategy before rebuilding
a published repo, for example squashing the data commit or keeping data on an
orphan branch.

The `.nojekyll` file at the repo root must stay: without it, GitHub Pages runs
Jekyll over the tree, which is slow and unnecessary at this size.
