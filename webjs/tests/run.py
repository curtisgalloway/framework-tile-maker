#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Curtis Galloway
# SPDX-License-Identifier: Apache-2.0
"""Regression test runner for the browser implementation.

    python3 webjs/tests/run.py            # run the suite, exit non-zero on failure
    python3 webjs/tests/run.py --headed   # watch it run in a visible browser

The browser version has to be driven by a real browser: its SVG loader uses
the browser's own SVG engine on purpose, and its raster path uses canvas.
jsdom implements neither, so headless Chrome is the only honest harness.

expected.json holds GOLDEN VALUES, not a live cross-check. They were derived
from the Python reference implementation that used to live in this repo, and
were correct against it when recorded; that implementation has since been
removed, so these are now a frozen snapshot. A failure means the browser code
changed behaviour -- which is what you want a regression suite to tell you --
but it no longer means "the browser disagrees with an independent
implementation", because there is no longer an independent implementation.

Several checks do not depend on the golden values at all and are stronger for
it: body + ink reconstructing the base to 0.00002 mm3, watertightness,
distinct filament slots per colour, and whether the thin-feature warnings
fire. Those are invariants, and they would catch a real geometry regression
even with every recorded number deleted.

stdlib only. No third-party packages at all.
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome", "chromium", "chromium-browser", "chrome",
]


def find_chrome() -> str:
    for c in CHROME_CANDIDATES:
        if os.path.isabs(c):
            if os.path.exists(c):
                return c
        else:
            p = shutil.which(c)
            if p:
                return p
    raise SystemExit(
        "no Chrome/Chromium found. Set CHROME=/path/to/chrome, or run the "
        "suite by hand: serve the repo and open /webjs/tests/")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def serve(port: int, sink: list):
    """Static file server for the repo, plus a sink the page POSTs results to."""

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(ROOT), **kw)

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(n)
            try:
                sink.append(json.loads(body))
            except Exception as e:
                sink.append({"fatal": f"could not parse results: {e}"})
            self.send_response(204)
            self.end_headers()

        def log_message(self, *a):
            pass

    httpd = Server(("127.0.0.1", port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


# ------------------------------------------------------------------- the run

def main(argv=None):
    ap = argparse.ArgumentParser(prog="webjs-tests")
    ap.add_argument("--headed", action="store_true",
                    help="run in a visible browser instead of headless")
    ap.add_argument("--timeout", type=float, default=300.0)
    ap.add_argument("--no-sandbox", action="store_true",
                    default=bool(os.environ.get("CI")),
                    help="pass --no-sandbox to Chrome (default on when CI is "
                         "set; the sandbox needs kernel features many CI "
                         "containers do not grant)")
    a = ap.parse_args(argv)

    exp_path = HERE / "expected.json"
    if not exp_path.exists():
        raise SystemExit(f"{exp_path} missing -- it is committed; restore it "
                         f"from git")

    chrome = os.environ.get("CHROME") or find_chrome()
    port = free_port()
    results: list = []
    httpd = serve(port, results)
    url = f"http://127.0.0.1:{port}/webjs/tests/?report=1"

    profile = tempfile.mkdtemp(prefix="tilegen-tests-")
    cmd = [chrome, f"--user-data-dir={profile}", "--no-first-run",
           "--no-default-browser-check", "--disable-extensions",
           # A headless tab is 'hidden', which pauses rAF -- the app yields
           # through a timeout fallback for exactly this reason, but keeping
           # the renderer running makes the run behave like a visible tab.
           "--disable-backgrounding-occluded-windows",
           "--disable-renderer-backgrounding", url]
    if not a.headed:
        cmd.insert(1, "--headless=new")
        cmd.insert(2, "--disable-gpu")
    if a.no_sandbox:
        cmd.insert(1, "--no-sandbox")

    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + a.timeout
        while not results and time.time() < deadline:
            if proc.poll() is not None and not results:
                time.sleep(0.5)
                break
            time.sleep(0.2)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    if not results:
        print("no results: the browser never reported back "
              f"(waited {a.timeout:.0f}s). Try --headed to watch it, or "
              f"--no-sandbox if this is a container.")
        return 2

    rep = results[0]
    if "fatal" in rep:
        print("FATAL:", rep["fatal"])
        return 2

    failed = 0
    for sec in rep["sections"]:
        print(f"\n{sec['name']}")
        for chk in sec["checks"]:
            ok = chk["ok"]
            failed += 0 if ok else 1
            detail = f"   {chk['detail']}" if chk.get("detail") else ""
            print(f"  {'PASS' if ok else 'FAIL'}  {chk['name']}{detail}")

    total = sum(len(s["checks"]) for s in rep["sections"])
    print()
    if failed:
        print(f"{failed} of {total} FAILED")
        return 1
    print(f"all {total} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
