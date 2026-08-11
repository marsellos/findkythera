"""Static file server WITH HTTP Range support, for local testing of FindKythera.

python -m http.server cannot serve this site: sql.js-httpvfs fetches the database
in small ranges, and without Range support it falls back to downloading every chunk
whole. This server adds single-range support to SimpleHTTPRequestHandler.

Usage: python tools/serve.py [port]   (from the findkythera folder; default 8000)
"""
import os
import re
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class RangeHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path) or "Range" not in self.headers:
            return super().send_head()
        m = RANGE_RE.match(self.headers["Range"] or "")
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start = int(m.group(1)) if m.group(1) else 0
        end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_error(416, "Requested Range Not Satisfiable")
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._range_span = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        span = getattr(self, "_range_span", None)
        try:
            if span is None:
                return super().copyfile(source, outputfile)
            outputfile.write(source.read(span))
        finally:
            if span is not None:
                self._range_span = None


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.join(os.path.dirname(__file__), ".."))
    print(f"Serving FindKythera on http://localhost:{port} (Range enabled)")
    ThreadingHTTPServer(("", port), RangeHandler).serve_forever()
