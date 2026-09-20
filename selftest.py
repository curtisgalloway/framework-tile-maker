#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Curtis Galloway
# SPDX-License-Identifier: Apache-2.0
"""Regression checks for tilegen. Run: python3 selftest.py

Each check has failed at least once during development, which is why it is here.
"""
import glob, io, json, os, subprocess, sys, tempfile, zipfile
import xml.etree.ElementTree as ET

import numpy as np
import trimesh
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
SVG = os.path.join(HERE, "examples", "fuchsia.svg")
NS = {"c": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}

fails = []
skipped = []


def find_cairo():
    """Put libcairo where cairocffi's ctypes lookup will find it.

    cairosvg -> cairocffi -> ctypes.util.find_library("cairo"), which on macOS
    searches only DYLD_*_LIBRARY_PATH, /usr/local/lib and /usr/lib.  Homebrew
    on Apple silicon installs to /opt/homebrew/lib, which is on none of those,
    so an installed cairo still fails to load.  find_library reads os.environ
    at call time, so setting the fallback path here is enough -- but it has to
    happen before cairosvg is imported.
    """
    import ctypes.util
    if ctypes.util.find_library("cairo"):
        return True
    extra = [d for d in ("/opt/homebrew/lib", "/usr/local/lib", "/opt/local/lib")
             if os.path.isdir(d)]
    if not extra:
        return False
    cur = os.environ.get("DYLD_FALLBACK_LIBRARY_PATH", "")
    os.environ["DYLD_FALLBACK_LIBRARY_PATH"] = os.pathsep.join(
        [d for d in [cur, *extra] if d])
    return bool(ctypes.util.find_library("cairo"))


def skip(section, why):
    print(f"  SKIP  {section} -- {why}")
    skipped.append(section)


def check(name, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))
    if not cond:
        fails.append(name)


def run(*args):
    out = os.path.join(TMP, "o" + str(abs(hash(args)) % 10000))
    r = subprocess.run([sys.executable, os.path.join(HERE, "tilegen.py"), SVG,
                        "-o", out, *args], capture_output=True, text=True)
    if r.returncode:
        print(r.stdout, r.stderr)
        raise SystemExit("tilegen failed")
    return out, r.stdout


TMP = tempfile.mkdtemp(prefix="tilegen-selftest-")
base = trimesh.load(os.path.join(HERE, "assets", "tile_base.stl"))

print("\n1. tile base")
check("base is watertight", base.is_watertight)
check("base is 28.5 x 28.5 x 4.4 mm",
      np.allclose(base.extents, [28.5, 28.5, 4.4], atol=1e-3),
      str(np.round(base.extents, 3)))
check("decorated face sits at z=0", abs(base.bounds[0][2]) < 1e-9)

print("\n2. single tile, margin 2.5")
out, log = run("--margin", "2.5")
body = trimesh.load(os.path.join(out, "fuchsia_body.stl"))
ink = trimesh.load(glob.glob(os.path.join(out, "fuchsia_ink*.stl"))[0])
check("body watertight", body.is_watertight)
check("ink watertight", ink.is_watertight)
check("body + ink reconstruct the base",
      abs(base.volume - (body.volume + ink.volume)) < 1e-3,
      f"delta {base.volume-(body.volume+ink.volume):+.6f} mm3")
check("ink spans exactly the inlay depth",
      np.allclose(ink.bounds[:, 2], [0.0, 0.6], atol=1e-6),
      str(np.round(ink.bounds[:, 2], 4)))

# THE BUG THIS FILE EXISTS FOR: artwork was sized to the tile pitch (28.6) but
# clipped to face - 2*margin (23.5), silently cropping 18% off the edges.
usable = 28.5 - 2 * 2.5
e = ink.extents[:2]
check("artwork fits inside the usable face, not the pitch",
      e[0] <= usable + 1e-3 and e[1] <= usable + 1e-3,
      f"{e[0]:.3f} x {e[1]:.3f} mm in {usable:.3f} mm")
check("artwork touches the usable edge (fit is tight, not shrunken)",
      max(e) > usable - 0.05, f"largest extent {max(e):.3f}")
src_aspect = 476.998 / 509.998          # measured from the path data
check("aspect ratio preserved (nothing cropped)",
      abs(e[0] / e[1] - src_aspect) < 0.01,
      f"{e[0]/e[1]:.4f} vs {src_aspect:.4f}")
check("no crop warning at default scale", "runs past the tile area" not in log)

print("\n3. cropping is reported when it is real")
_, log = run("--margin", "2.5", "--scale", "130", "--no-stl", "--no-3mf", "--no-preview")
check("overscale warns", "runs past the tile area" in log)

def section_orientation():
    """Section the finished ink just under the face and compare, as seen from
    -z, against the source artwork.  Catches an accidental mirror.

    cairosvg is the reference renderer on purpose: it parses the SVG entirely
    independently of tilegen, so a shared bug cannot make both sides agree.
    Rasterizing with tilegen's own load_svg would check the parser against
    itself and pass no matter what it got wrong -- which is why this section
    skips when cairo is missing instead of falling back to that.
    """
    import cairosvg

    from PIL import Image
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Polygon as MplPoly
    from shapely.geometry import Polygon

    sys.path.insert(0, HERE)
    import tilegen as T

    N = 600
    png = cairosvg.svg2png(url=SVG, output_width=N, output_height=N, background_color="white")
    ref = np.array(Image.open(io.BytesIO(png)).convert("L")) < 128

    regs = T.load_svg(SVG)
    g2d = unary_union([r.geom for r in regs])
    world = T.to_world(g2d, mirror=False)


    def raster(geom, n=N, vb=512.0):
        """Draw world-space geometry the way a viewer outside the case sees it.

        Frame it to the SVG viewBox mapped through to_world (u,v in [0,vb] becomes
        X,Y in [-vb,0]) so it lines up pixel-for-pixel with the cairosvg reference.
        Viewer at -z: screen-right = -X (so xlim descends), screen-up = +Y.
        """
        fig = plt.figure(figsize=(n / 100, n / 100), dpi=100)
        ax = fig.add_axes([0, 0, 1, 1])
        ax.set_xlim(0.0, -vb)      # left edge = X 0 = u 0
        ax.set_ylim(-vb, 0.0)      # top edge  = Y 0 = v 0
        ax.axis("off")
        polys = [geom] if isinstance(geom, Polygon) else list(geom.geoms)
        for p in polys:
            ax.add_patch(MplPoly(np.array(p.exterior.coords), closed=True,
                                 facecolor="black", edgecolor="none"))
            for r in p.interiors:
                ax.add_patch(MplPoly(np.array(r.coords), closed=True,
                                     facecolor="white", edgecolor="none"))
        buf = io.BytesIO()
        fig.savefig(buf, format="png", facecolor="white")
        plt.close(fig)
        return np.array(Image.open(buf).convert("L").resize((n, n))) < 128


    mine = raster(world)
    iou = (ref & mine).sum() / (ref | mine).sum()
    check("tile face matches the source SVG, not its mirror", iou > 0.97, f"IoU {iou:.4f}")
    flipped = mine[:, ::-1]
    check("mirrored version scores worse (test is actually sensitive)",
          (ref & flipped).sum() / (ref | flipped).sum() < iou,
          f"mirrored IoU {(ref&flipped).sum()/(ref|flipped).sum():.4f}")



print("\n4. orientation")
if not find_cairo():
    skip("4. orientation",
         "libcairo not found (macOS: brew install cairo; "
         "Debian/Ubuntu: apt install libcairo2)")
else:
    try:
        section_orientation()
    except ImportError as e:
        skip("4. orientation", f"cairosvg unavailable: {e}")

print("\n5. 3MF structure")
out, _ = run("--margin", "2.5")
p = os.path.join(out, "fuchsia.3mf")
z = zipfile.ZipFile(p)
need = {"[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model",
        "Metadata/model_settings.config"}
check("all required entries present", need <= set(z.namelist()))
m = ET.fromstring(z.read("3D/3dmodel.model"))
app = [e.text for e in m.findall("c:metadata", NS) if e.get("name") == "Application"]
check("Application tag present (else the slicer treats it as third-party)",
      bool(app) and app[0].startswith(("BambuStudio-", "OrcaSlicer-")))
objs = {}
for o in m.find("c:resources", NS).findall("c:object", NS):
    mesh, comps = o.find("c:mesh", NS), o.find("c:components", NS)
    objs[int(o.get("id"))] = ("mesh" if mesh is not None
                              else [int(c.get("objectid")) for c in comps])
cfg = ET.fromstring(z.read("Metadata/model_settings.config"))
ok_ids, ok_ext, ok_mat = True, True, True
for co in cfg.findall("object"):
    comp = objs[int(co.get("id"))]
    if [int(pp.get("id")) for pp in co.findall("part")] != comp:
        ok_ids = False
    for pp in co.findall("part"):
        md = {x.get("key"): x.get("value") for x in pp.findall("metadata")}
        if int(md.get("extruder", 0)) < 1:
            ok_ext = False
        if len(md.get("matrix", "").split()) != 16:
            ok_mat = False
check("part ids match component order (else filaments mis-assign silently)", ok_ids)
check("every extruder >= 1 (0 means 'default', not filament 1)", ok_ext)
check("matrix metadata is 16 values (12 silently becomes identity)", ok_mat)
sc = trimesh.load(p)
check("3MF round-trips to the same volume",
      abs(sum(x.volume for x in sc.geometry.values()) - base.volume) < 1e-3)

print("\n6. full panel")
out, log = run("--grid", "3x7", "--fit", "cover", "--keep-empty", "--no-stl")
z = zipfile.ZipFile(os.path.join(out, "fuchsia_3x7.3mf"))
cfg = ET.fromstring(z.read("Metadata/model_settings.config"))
check("21 tiles emitted", len(cfg.findall("object")) == 21,
      f"{len(cfg.findall('object'))}")

print("\n7. multi-color filament mapping")
# Three colors in three vertical bands across a 3x1 grid, so each tile sees
# exactly one of them. Before the slot fix every tile numbered its inks from
# scratch, so all three distinct colors came out as filament 2 and a
# three-color panel sliced as one color with no warning anywhere.
from PIL import Image as _Image

_bands = os.path.join(TMP, "bands.png")
_im = _Image.new("RGB", (900, 300))
_px = _im.load()
_cols = [(255, 0, 0), (0, 160, 0), (0, 0, 255)]
for _x in range(900):
    for _y in range(300):
        _px[_x, _y] = _cols[min(2, _x // 300)]
_im.save(_bands)


def run_art(art, *args):
    out = os.path.join(TMP, "a" + str(abs(hash((art, args))) % 10000))
    r = subprocess.run([sys.executable, os.path.join(HERE, "tilegen.py"), art,
                        "-o", out, *args], capture_output=True, text=True)
    if r.returncode:
        print(r.stdout, r.stderr)
        raise SystemExit("tilegen failed")
    return out, r.stdout


_base_args = ("--grid", "3x1", "--colors", "3", "--margin", "0",
              "--fit", "stretch", "--background", "none", "--no-stl")
_out, _ = run_art(_bands, *_base_args)
_z = zipfile.ZipFile(os.path.join(_out, "bands_3x1.3mf"))
_cfg = ET.fromstring(_z.read("Metadata/model_settings.config"))

_by_color = {}
for _o in _cfg.findall("object"):
    for _p in _o.findall("part"):
        _md = {m.get("key"): m.get("value") for m in _p.findall("metadata")}
        if _md["name"] != "body":
            _by_color.setdefault(_md["name"].split("_")[-1], set()).add(_md["extruder"])

check("each color maps to exactly one filament across tiles",
      all(len(v) == 1 for v in _by_color.values()),
      " ".join(f"{k}->{sorted(v)}" for k, v in sorted(_by_color.items())))
check("distinct colors get distinct filaments",
      len({tuple(v) for v in _by_color.values()}) == len(_by_color),
      f"{len(_by_color)} colors")
check("no color is assigned filament 1 (that is the body)",
      all("1" not in v for v in _by_color.values()))

_out, _log = run_art(_bands, *_base_args, "--embed-filaments",
                     "--body-color", "2f2f31", "--filament-type", "PETG")
_z = zipfile.ZipFile(os.path.join(_out, "bands_3x1.3mf"))
check("project_settings.config written with --embed-filaments",
      "Metadata/project_settings.config" in _z.namelist())
_ps = json.loads(_z.read("Metadata/project_settings.config"))
check("body color lands in filament slot 1",
      _ps["filament_colour"][0] == "#2F2F31", _ps["filament_colour"][0])
check("filament type recorded for every slot",
      _ps["filament_type"] == ["PETG"] * len(_ps["filament_colour"]),
      str(_ps["filament_type"]))

# The color array is indexed from filament 1, so a part on extruder N must
# find its own color at index N-1. This is the check that would catch an
# off-by-one between the two files.
_cfg = ET.fromstring(_z.read("Metadata/model_settings.config"))
_aligned = True
for _o in _cfg.findall("object"):
    for _p in _o.findall("part"):
        _md = {m.get("key"): m.get("value") for m in _p.findall("metadata")}
        if _md["name"] == "body":
            continue
        _want = _md["name"].split("_")[-1].upper()
        if _ps["filament_colour"][int(_md["extruder"]) - 1] != _want:
            _aligned = False
check("every part's extruder indexes its own color in filament_colour",
      _aligned)

_out, _ = run_art(_bands, *_base_args)
_z = zipfile.ZipFile(os.path.join(_out, "bands_3x1.3mf"))
check("no project_settings.config without the flag (default is unchanged)",
      "Metadata/project_settings.config" not in _z.namelist())

print("\n8. tile bases")
# Every base has to be a closed solid or the boolean stage cannot use it, and
# body + ink has to reconstruct whichever base was chosen -- not just blank.
sys.path.insert(0, HERE)
import tilegen as _T

for _name, _file in sorted(_T.BASES.items()):
    _b = trimesh.load(os.path.join(HERE, "assets", _file))
    check(f"{_name} base is watertight", _b.is_watertight,
          f"vol {_b.volume:.2f}, {len(_b.faces)} faces")
    check(f"{_name} base is 28.5 x 28.5 x 4.4 mm",
          bool(np.allclose(_b.extents, [28.5, 28.5, 4.4], atol=0.02)),
          str(_b.extents.round(3)))

_out, _ = run("--margin", "2.5", "--base", "grid", "--no-3mf")
_gb = trimesh.load(os.path.join(_out, "fuchsia_body.stl"))
_gi = [trimesh.load(p) for p in glob.glob(os.path.join(_out, "fuchsia_ink_*.stl"))]
_grid = trimesh.load(os.path.join(HERE, "assets", _T.BASES["grid"]))
check("body + ink reconstruct the grid base",
      abs(_grid.volume - (_gb.volume + sum(i.volume for i in _gi))) < 1e-3,
      f"delta {abs(_grid.volume - (_gb.volume + sum(i.volume for i in _gi))):+.6f} mm3")

_, _log = run("--margin", "2.5", "--base", "cross", "--no-stl", "--no-3mf",
              "--no-preview")
check("open-faced bases warn about fragmentation",
      "open face" in _log and "fragment" in _log)
_, _log = run("--margin", "2.5", "--base", "blank", "--no-stl", "--no-3mf",
              "--no-preview")
check("blank base does not warn", "open face" not in _log)

print()
if skipped:
    print(f"{len(skipped)} section(s) SKIPPED: " + ", ".join(skipped))
if fails:
    print(f"{len(fails)} FAILED: " + ", ".join(fails))
    sys.exit(1)
print("all checks passed" + (" (some sections skipped -- see above)" if skipped else ""))
