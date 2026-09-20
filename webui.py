#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Curtis Galloway
# SPDX-License-Identifier: Apache-2.0
"""Local web front end for tilegen. Run: python3 webui.py

Binds to 127.0.0.1 only. This is a convenience wrapper for one person on one
machine -- there is no auth, no upload cap and no job queue, so do not expose
it to a network.

It drives the CLI as a subprocess rather than importing the pipeline. That
keeps the CLI the single definition of what a run does: the form maps 1:1 onto
flags, and anything this page produces can be reproduced by pasting the
command it shows back at you.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

HERE = Path(__file__).resolve().parent
PAGE = HERE / "web" / "index.html"
JOBS = Path(tempfile.gettempdir()) / "tilegen-webui"
JOBS.mkdir(parents=True, exist_ok=True)

# Keep the last N job directories so previews and downloads stay valid while
# you iterate, without growing without bound across a long session.
KEEP_JOBS = 20
ART_SUFFIXES = {".svg", ".png", ".jpg", ".jpeg", ".webp"}

app = FastAPI(title="tilegen", docs_url=None, redoc_url=None)


def reap_old_jobs():
    jobs = sorted((d for d in JOBS.iterdir() if d.is_dir()),
                  key=lambda d: d.stat().st_mtime, reverse=True)
    for d in jobs[KEEP_JOBS:]:
        shutil.rmtree(d, ignore_errors=True)


def job_dir(job: str) -> Path:
    """Resolve a job id to its directory, refusing anything path-shaped.

    The id goes into a filesystem path, so it is validated as a uuid rather
    than trusted: '..%2f..' in this position would otherwise read any file the
    server user can see.
    """
    try:
        uuid.UUID(job)
    except ValueError:
        raise HTTPException(400, "bad job id")
    d = JOBS / job
    if not d.is_dir():
        raise HTTPException(404, "no such job")
    return d


def safe_output(job: str, name: str) -> Path:
    """Resolve one output file inside a job, refusing traversal out of it."""
    d = job_dir(job)
    p = (d / "out" / name).resolve()
    if not p.is_file() or d.resolve() not in p.parents:
        raise HTTPException(404, "no such file")
    return p


@app.get("/", response_class=HTMLResponse)
def index():
    return PAGE.read_text()


@app.post("/generate")
def generate(
    art: UploadFile,
    cols: int = Form(1),
    rows: int = Form(1),
    margin: float = Form(0.0),
    depth: float = Form(0.6),
    fit: str = Form("contain"),
    colors: int = Form(2),
    background: str = Form("auto"),
    scale: float = Form(100.0),
    rotate: float = Form(0.0),
    bleed: float = Form(0.0),
    nozzle: float = Form(0.4),
    layer: float = Form(0.2),
    invert: bool = Form(False),
    mirror: bool = Form(False),
    keep_empty: bool = Form(True),
    embed_filaments: bool = Form(False),
    body_color: str = Form(""),
    filament_type: str = Form("PLA"),
):
    # The panel is 3x7; allow past that for oversized artwork, but keep it two
    # digits so a typo cannot ask for a million tiles and wedge the machine.
    if not (1 <= cols <= 99 and 1 <= rows <= 99):
        raise HTTPException(400, "columns and rows must each be between 1 and 99")

    suffix = Path(art.filename or "").suffix.lower()
    if suffix not in ART_SUFFIXES:
        raise HTTPException(400,
                            f"unsupported file type '{suffix or art.filename}'. "
                            f"Use {', '.join(sorted(ART_SUFFIXES))}")

    job = str(uuid.uuid4())
    d = JOBS / job
    (d / "out").mkdir(parents=True)

    # Keep the uploaded name: tilegen derives every output filename from the
    # stem, so a placeholder here would make the downloads unrecognizable.
    src = d / Path(art.filename).name
    with src.open("wb") as fh:
        shutil.copyfileobj(art.file, fh)

    cmd = [sys.executable, str(HERE / "tilegen.py"), str(src),
           "-o", str(d / "out"),
           "--grid", f"{cols}x{rows}", "--margin", str(margin), "--depth", str(depth),
           "--fit", fit, "--colors", str(colors), "--background", background,
           "--scale", str(scale), "--rotate", str(rotate), "--bleed", str(bleed),
           "--nozzle", str(nozzle), "--layer", str(layer)]
    if invert:
        cmd.append("--invert")
    if mirror:
        cmd.append("--mirror")
    if keep_empty:
        cmd.append("--keep-empty")
    if embed_filaments:
        cmd += ["--embed-filaments", "--filament-type", filament_type]
        # Blank means "do not claim to know what spool is in slot 1"; tilegen
        # then leaves that entry empty rather than inventing a color.
        if body_color.strip():
            cmd += ["--body-color", body_color.strip()]

    r = subprocess.run(cmd, capture_output=True, text=True)
    # tilegen prints absolute output paths, which here are inside a temp job
    # directory nobody wants to read. Show them as 'out/NAME' so the console
    # matches the command shown underneath it.
    log = (r.stdout + r.stderr).replace(str(d / "out"), "out").replace(str(d), "").strip()

    # Show the equivalent command with the upload's own name, so it can be
    # pasted into a shell next to the file rather than pointing at a temp dir.
    shown = [c for c in cmd[1:]]
    shown[0] = "tilegen.py"
    shown[1] = Path(art.filename).name
    shown[2:4] = ["-o", "out"]
    command = "python3 " + " ".join(shown)

    if r.returncode != 0:
        reap_old_jobs()
        return JSONResponse(
            {"ok": False, "log": log or "tilegen exited with no output",
             "command": command},
            status_code=200)

    outs = sorted(p.name for p in (d / "out").iterdir() if p.is_file())
    preview = next((n for n in outs if n.endswith("_preview.png")), None)

    # A cell the artwork does not reach is dropped unless --keep-empty, so a
    # panel can come back with holes in it. That is easy to miss in a wall of
    # filenames, so report the count explicitly and let the page say so.
    skipped = log.count("no artwork in this cell, skipped")
    reap_old_jobs()
    return {
        "ok": True,
        "job": job,
        "log": log,
        "command": command,
        "preview": preview,
        "files": [n for n in outs if n != preview],
        "tiles": {"requested": cols * rows,
                  "made": cols * rows - skipped,
                  "skipped": skipped},
    }


@app.get("/file/{job}/{name}")
def file(job: str, name: str):
    p = safe_output(job, name)
    return FileResponse(p, filename=p.name)


@app.get("/preview/{job}/{name}")
def preview(job: str, name: str):
    return FileResponse(safe_output(job, name), media_type="image/png")


def port_is_taken(host: str, port: int) -> bool:
    """True if something already listens on host:port.

    Worth checking rather than letting the bind fail: binding 127.0.0.1:N
    succeeds even when another process holds 0.0.0.0:N, and then requests can
    land on either server depending on the OS. That failure looks like tilegen
    returning someone else's response, which is a confusing thing to debug.
    """
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex((host, port)) == 0


def main(argv=None):
    import argparse
    import uvicorn

    ap = argparse.ArgumentParser(prog="tilegen-web", description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8770, help="default: 8770")
    ap.add_argument("--host", default="127.0.0.1",
                    help="default: 127.0.0.1 (loopback only; there is no auth)")
    a = ap.parse_args(argv)

    if port_is_taken(a.host, a.port):
        raise SystemExit(
            f"port {a.port} is already in use on {a.host}. Pick another with "
            f"--port, or stop whatever holds it:\n"
            f"    lsof -nP -iTCP:{a.port} -sTCP:LISTEN")

    if a.host not in ("127.0.0.1", "localhost"):
        print(f"  ! serving on {a.host}: this app has no auth and no upload "
              f"limit. Loopback only is strongly recommended.")
    print(f"tilegen web UI -> http://{a.host}:{a.port}   (ctrl-c to stop)")
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    sys.exit(main())
