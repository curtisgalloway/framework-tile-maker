#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Curtis Galloway
# SPDX-License-Identifier: Apache-2.0
"""Differential test runner for the browser implementation.

    python3 webjs/tests/run.py            # run the suite, exit non-zero on failure
    python3 webjs/tests/run.py --update   # recompute expected.json from tilegen.py
    python3 webjs/tests/run.py --headed   # watch it run in a visible browser

The browser version has to be driven by a real browser: its SVG loader uses
the browser's own SVG engine on purpose, and its raster path uses canvas.
jsdom implements neither, so headless Chrome is the only honest harness.

Expected values come from tilegen.py, which stays the reference. They are
recorded in expected.json rather than computed on every run so a failure
points at a change in the browser code rather than at whichever numpy landed
this morning -- and `--update` regenerates them when the Python legitimately
moves.

stdlib only, apart from what tilegen.py already needs for --update.
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


# ---------------------------------------------------------------- expectations

def build_expectations() -> dict:
    """Derive the reference numbers by driving tilegen.py directly."""
    sys.path.insert(0, str(ROOT))
    import trimesh
    import tilegen as T

    def tile(base_name, cols=1, rows=1, margin=2.5, fit="contain", art=None,
             colors=2, background="auto"):
        base = trimesh.load(str(ROOT / "assets" / T.BASES[base_name]))
        art = art or (ROOT / "examples" / "fuchsia.svg")
        if str(art).lower().endswith(".svg"):
            regions = T.load_svg(art)
        else:
            regions = T.load_raster(art, n_colors=colors)
        regions = T.resolve_overlaps(regions)
        bgi = T.pick_background(regions, background)
        if bgi is not None:
            regions = [r for i, r in enumerate(regions) if i != bgi]
        regions, _ = T.fit_transform(regions, cols, rows, T.PITCH, T.TILE,
                                     margin, 0, fit, 0, 100, 0.02)
        for i, r in enumerate(regions):
            r.slot = i
        out = {"base_volume": round(float(base.volume), 4),
               "regions": len(regions), "tiles": {}}
        for r in range(rows):
            for c in range(cols):
                inks = T.clip_to_tile(regions, c, r, cols, rows, T.PITCH,
                                      T.TILE, margin)
                if not inks:
                    continue
                world = [T.to_world(x.geom, False) for x in inks]
                body, parts = T.build_tile(base, world, 0.6)
                out["tiles"][f"r{r}c{c}"] = {
                    "body": round(float(body.volume), 4),
                    "inks": [round(float(p.volume), 4) for p in parts],
                    "slots": [x.slot for x in inks],
                }
        return out

    cases = {}
    for b in sorted(T.BASES):
        cases[f"svg_1x1_{b}"] = tile(b)
    cases["svg_3x7_cover"] = tile("blank", cols=3, rows=7, margin=0, fit="cover")
    cases["raster_noise"] = tile("blank",
                                 art=HERE / "fixtures" / "noise.png",
                                 background="none")
    cases["raster_blobs"] = tile("blank",
                                 art=HERE / "fixtures" / "blobs.png")
    return {"note": "generated by webjs/tests/run.py --update from tilegen.py",
            "cases": cases}


# ------------------------------------------------------------------- the run

def main(argv=None):
    ap = argparse.ArgumentParser(prog="webjs-tests")
    ap.add_argument("--update", action="store_true",
                    help="recompute expected.json from tilegen.py and exit")
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
    if a.update:
        exp = build_expectations()
        exp_path.write_text(json.dumps(exp, indent=2) + "\n")
        n = sum(len(c["tiles"]) for c in exp["cases"].values())
        print(f"wrote {exp_path.relative_to(ROOT)}: "
              f"{len(exp['cases'])} cases, {n} tiles")
        return 0

    if not exp_path.exists():
        raise SystemExit(f"{exp_path} missing -- run with --update first")

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
