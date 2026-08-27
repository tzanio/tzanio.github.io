#!/usr/bin/env python3
"""Serve EigenDrum from the correct directory without npm."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os
import webbrowser

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8000"))
os.chdir(ROOT)
url = f"http://localhost:{PORT}/"
print(f"Serving EigenDrum at {url}")
print("Press Ctrl-C to stop.")
try:
    webbrowser.open(url)
except Exception:
    pass
ThreadingHTTPServer(("", PORT), SimpleHTTPRequestHandler).serve_forever()
