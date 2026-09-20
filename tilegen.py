#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Curtis Galloway
# SPDX-License-Identifier: Apache-2.0
"""
tilegen - turn any SVG or raster image into Framework Desktop front-panel tiles,
split across a tile grid, as multi-color parts ready to slice.

The tile body geometry comes from tile_base.scad by Marcin Raczkowski (Marmot.Tech),
CC BY-SA 4.0.  See README.md / --credits.  This tool only adds artwork to it.
"""
from __future__ import annotations

import argparse, json, math, os, sys, zipfile, colorsys
from dataclasses import dataclass, field
from pathlib import Path as FsPath
from xml.sax.saxutils import escape

import numpy as np
import trimesh
from shapely.geometry import Polygon, MultiPolygon, box
from shapely.ops import unary_union
from shapely import affinity

# ----------------------------------------------------------------------------
# Framework Desktop front panel geometry.
#
# PITCH is measured from Framework's own released CAD
# (Tiles/fw_desktop_front_cover.stl): the tile openings step by exactly 28.60 mm
# in both axes.  Several community projects use 28.5 and accumulate ~0.6 mm of
# drift over 7 rows.  At the depth where the tile face sits, the cover has no
# material at all across the grid, so the whole tile face is visible and
# adjacent tiles meet with only a ~0.10-0.15 mm seam.
# ----------------------------------------------------------------------------
PITCH       = 28.60     # tile center-to-center, mm
TILE        = 28.50     # printed tile outer size (tile_base.scad tile_size)
PANEL_COLS  = 3         # tiles across the panel width
PANEL_ROWS  = 7         # tiles down the panel height
SAFE_DEPTH  = 1.60      # below this z the tile is solid across its full face

# Tile bases, mapped to their cached render. They are produced by
# bases/tilegen_bases.scad, which includes the vendored tile_base.scad
# unmodified and composes its modules -- the extension point that file's own
# usage comment documents. See that file for why the stripes are not simply
# tile_base.scad's own crosshatch_fill.
BASES = {
    "blank":      "tile_base.stl",
    "frame":      "tile_base_frame.stl",
    "horizontal": "tile_base_horizontal.stl",
    "cross":      "tile_base_cross.stl",
    "grid":       "tile_base_grid.stl",
}
# Bases whose face is not solid. Artwork over an opening has no material to
# carve, so it does not print there -- which is the point of these, but it
# surprises people the first time.
OPEN_FACE = {"frame", "horizontal", "cross", "grid"}

CREDITS = """\
tile_base.scad  - Marcin Raczkowski (Marmot.Tech), CC BY-SA 4.0
                  https://github.com/jermicide/desktoptiles
                  Vendored unmodified as a git submodule at
                  vendor/desktoptiles -- no copy lives in this repo.
                  Tile geometry derives from Framework's published spec:
                  FrameworkComputer/Framework-Desktop -> Tiles/
Panel pitch     - measured from FrameworkComputer/Framework-Desktop
                  Tiles/fw_desktop_front_cover.stl

tilegen itself (tilegen.py, selftest.py) is Apache 2.0, (c) 2026 Curtis
Galloway.  That covers the code only.  Because tile_base.scad is CC BY-SA 4.0,
every tile this tool produces is a derivative work of it: if you publish or
sell them, credit Marmot.Tech, say the work was modified, and license the
tiles under CC BY-SA 4.0 as well.  See README.md -> "Licensing".
"""

EPS = 0.05


# ============================================================================
# artwork -> 2D regions
# ============================================================================

@dataclass
class Region:
    """One color's worth of artwork, in view space (u right, v down)."""
    name: str
    rgb: tuple
    geom: object
    order: int = 0
    # Index of this color among all the artwork's colors, assigned once
    # before tiles are cut and carried through clipping. The filament a part
    # prints in is slot + 2, so it MUST be global: a per-tile index makes the
    # same color print as filament 2 on one tile and filament 3 on the next.
    slot: int = 0


def _signed_area(ring):
    x = np.asarray([p[0] for p in ring]); y = np.asarray([p[1] for p in ring])
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _rings_to_geom(rings, fill_rule):
    """Combine subpath rings into a polygon honouring the SVG fill rule.

    even-odd is an XOR.  nonzero needs winding numbers: a ring only carves a
    hole if it winds opposite to what encloses it.  Getting this wrong turns
    counters (the inside of an 'o', the eye of a spiral) solid or hollow.
    """
    polys, signs = [], []
    for r in rings:
        if len(r) < 3:
            continue
        p = Polygon(r)
        if not p.is_valid:
            p = p.buffer(0)
        if p.is_empty or p.area <= 0:
            continue
        polys.append(p)
        signs.append(1 if _signed_area(r) > 0 else -1)
    if not polys:
        return MultiPolygon()

    if fill_rule == "evenodd":
        out = polys[0]
        for p in polys[1:]:
            out = out.symmetric_difference(p)
        return out

    # nonzero: partition into cells, keep cells whose winding number != 0
    keep = []
    for i, pi in enumerate(polys):
        inner = [pj for j, pj in enumerate(polys) if j != i and pj.within(pi)]
        cell = pi.difference(unary_union(inner)) if inner else pi
        if cell.is_empty:
            continue
        rep = cell.representative_point()
        wind = sum(s for p, s in zip(polys, signs) if p.contains(rep))
        if wind != 0:
            keep.append(cell)
    return unary_union(keep) if keep else MultiPolygon()


def load_svg(path, tol=0.02, fill_rule=None):
    from svgelements import SVG, Path as SPath, Shape, Move, Close, Line

    svg = SVG.parse(str(path), reify=True)
    buckets, order = {}, {}

    def flatten(sub):
        pts = []
        for seg in sub:
            if isinstance(seg, (Move, Close)):
                continue
            if isinstance(seg, Line):
                pts.append((seg.end.x, seg.end.y))
                continue
            try:
                L = float(seg.length(error=tol / 10.0))
            except Exception:
                L = 10.0
            n = int(max(2, min(600, math.ceil(L / max(tol, 1e-6)))))
            for k in range(1, n + 1):
                p = seg.point(k / n)
                pts.append((p.x, p.y))
        out = []
        for p in pts:
            if not out or abs(p[0] - out[-1][0]) > 1e-9 or abs(p[1] - out[-1][1]) > 1e-9:
                out.append(p)
        return out

    idx = 0
    for el in svg.elements():
        if not isinstance(el, Shape):
            continue
        try:
            sp = abs(SPath(el))
        except Exception:
            continue
        fill = getattr(el, "fill", None)
        if fill is None or getattr(fill, "value", None) is None:
            continue
        try:
            if fill.alpha is not None and fill.alpha == 0:
                continue
        except Exception:
            pass
        rgb = (int(fill.red or 0), int(fill.green or 0), int(fill.blue or 0))

        rule = fill_rule
        if rule is None:
            raw = (el.values.get("fill-rule") or el.values.get("fill_rule") or "nonzero")
            rule = "evenodd" if str(raw).strip().lower() in ("evenodd", "even-odd") else "nonzero"

        rings = [flatten(s) for s in sp.as_subpaths()]
        g = _rings_to_geom(rings, rule)
        if g.is_empty:
            continue
        buckets.setdefault(rgb, []).append(g)
        order.setdefault(rgb, idx)
        idx += 1

    regions = [Region(name="#%02x%02x%02x" % rgb, rgb=rgb,
                      geom=unary_union(gs), order=order[rgb])
               for rgb, gs in buckets.items()]
    regions.sort(key=lambda r: r.order)
    return regions


def load_raster(path, n_colors=2, threshold=None, min_area_px=8.0,
                simplify_px=0.6, resample=1400):
    """Quantise a raster to n colors and vectorise each color's mask."""
    import cv2
    from PIL import Image

    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 0))
        im = Image.alpha_composite(bg, im)
        alpha = np.array(im.split()[-1])
        im_rgb = im.convert("RGB")
    else:
        im_rgb = im.convert("RGB")
        alpha = None

    w, h = im_rgb.size
    if max(w, h) > resample:
        s = resample / max(w, h)
        nw, nh = max(1, int(w * s)), max(1, int(h * s))
        im_rgb = im_rgb.resize((nw, nh), Image.LANCZOS)
        if alpha is not None:
            alpha = np.array(Image.fromarray(alpha).resize((nw, nh), Image.LANCZOS))
        w, h = nw, nh

    arr = np.array(im_rgb)
    transparent = (alpha is not None) and (alpha < 128)

    if threshold is not None or n_colors == 2:
        gray = np.array(im_rgb.convert("L"))
        if threshold is None:
            t, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        else:
            t = float(threshold)
        labels = (gray > t).astype(np.int32)     # 1 = light, 0 = dark
        palette = []
        for k in (0, 1):
            m = labels == k
            palette.append(tuple(int(v) for v in arr[m].mean(axis=0)) if m.any() else (0, 0, 0))
    else:
        q = im_rgb.quantize(colors=n_colors, method=Image.MEDIANCUT, dither=Image.NONE)
        labels = np.array(q, dtype=np.int32)
        pal = q.getpalette()[: n_colors * 3]
        palette = [tuple(pal[i * 3:i * 3 + 3]) for i in range(n_colors)]

    if alpha is not None:
        labels = np.where(transparent, -1, labels)

    regions = []
    for k, rgb in enumerate(palette):
        mask = (labels == k).astype(np.uint8) * 255
        if mask.max() == 0:
            continue
        g = _mask_to_geom(mask, min_area_px, simplify_px)
        if g.is_empty:
            continue
        regions.append(Region(name="#%02x%02x%02x" % tuple(rgb), rgb=tuple(rgb),
                              geom=g, order=k))
    return regions


def _mask_to_geom(mask, min_area_px, simplify_px):
    import cv2
    cnts, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return MultiPolygon()
    hier = hier[0]
    outers, holes = [], {}
    for i, c in enumerate(cnts):
        pts = c[:, 0, :].astype(float)
        if len(pts) < 3:
            continue
        p = Polygon(pts)
        if not p.is_valid:
            p = p.buffer(0)
        if p.is_empty or p.area < min_area_px:
            continue
        if simplify_px > 0:
            p = p.simplify(simplify_px, preserve_topology=True)
        if p.is_empty:
            continue
        if hier[i][3] == -1:
            outers.append((i, p))
        else:
            holes.setdefault(hier[i][3], []).append(p)
    out = []
    for i, p in outers:
        hs = holes.get(i, [])
        out.append(p.difference(unary_union(hs)) if hs else p)
    return unary_union(out) if out else MultiPolygon()


# ============================================================================
# layout
# ============================================================================

def pick_background(regions, mode="auto"):
    """Decide which color is 'the tile itself' rather than ink.

    An image's background should become the tile body: printing it as a second
    filament covers the body completely, wastes a color, and doubles purge.
    auto = whichever region covers most of the artwork's outer border.
    """
    if mode == "none" or len(regions) < 2:
        return None
    if mode.startswith("#"):
        want = tuple(int(mode[i:i + 2], 16) for i in (1, 3, 5))
        for i, r in enumerate(regions):
            if r.rgb == want:
                return i
        return None
    if mode.isdigit():
        i = int(mode)
        return i if 0 <= i < len(regions) else None

    u = unary_union([r.geom for r in regions])
    minx, miny, maxx, maxy = u.bounds
    n = 200
    pts = []
    for k in range(n):
        f = k / n
        pts += [(minx + f * (maxx - minx), miny), (minx + f * (maxx - minx), maxy),
                (minx, miny + f * (maxy - miny)), (maxx, miny + f * (maxy - miny))]
    from shapely.geometry import Point
    inset = max(maxx - minx, maxy - miny) * 0.004
    scores = []
    for r in regions:
        g = r.geom.buffer(inset)
        scores.append(sum(1 for p in pts if g.contains(Point(p))))
    best = int(np.argmax(scores))
    return best if scores[best] / len(pts) > 0.6 else None


def resolve_overlaps(regions):
    """Painter's algorithm: later artwork wins where regions overlap."""
    out = []
    for i, r in enumerate(regions):
        g = r.geom
        later = [regions[j].geom for j in range(i + 1, len(regions))]
        if later:
            g = g.difference(unary_union(later))
        if not g.is_empty:
            out.append(Region(r.name, r.rgb, g, r.order))
    return out


def fit_transform(regions, cols, rows, pitch, face, margin, bleed, fit, rotate,
                  scale_pct, tol_mm=0.0):
    """Map artwork into view-space millimeters, origin at panel center.

    View space: u right, v down -- the same handedness as the image, and the
    same as looking at the finished panel.
    """
    geoms = [r.geom for r in regions]
    if not geoms:
        raise SystemExit("no artwork regions found")
    if rotate:
        c = unary_union(geoms).centroid
        geoms = [affinity.rotate(g, rotate, origin=(c.x, c.y)) for g in geoms]
    u = unary_union(geoms)
    minx, miny, maxx, maxy = u.bounds
    aw, ah = max(maxx - minx, 1e-9), max(maxy - miny, 1e-9)

    # The canvas is the area artwork can actually occupy, which is NOT
    # cols*pitch: the outer tiles contribute only their face, and every tile
    # loses `margin` at each edge. Sizing to cols*pitch overscales by
    # (pitch - face) + 2*margin and silently crops the artwork.
    tw = (cols - 1) * pitch + face - 2 * margin + bleed
    th = (rows - 1) * pitch + face - 2 * margin + bleed
    if tw <= 0 or th <= 0:
        raise SystemExit(f"--margin {margin} leaves no room on a {face} mm tile")
    if fit == "contain":
        s = min(tw / aw, th / ah)
        sx = sy = s
    elif fit == "cover":
        s = max(tw / aw, th / ah)
        sx = sy = s
    else:  # stretch
        sx, sy = tw / aw, th / ah
    sx *= scale_pct / 100.0
    sy *= scale_pct / 100.0

    cx, cy = (minx + maxx) / 2.0, (miny + maxy) / 2.0
    out = []
    for r, g in zip(regions, geoms):
        g = affinity.translate(g, -cx, -cy)
        g = affinity.scale(g, sx, sy, origin=(0, 0))
        if tol_mm > 0:
            # Simplify in millimeters, not in artwork units. Curve flattening
            # fine enough for a 512-unit viewBox is thousands of times finer
            # than a printer resolves, and every extra point becomes triangles.
            g2 = g.simplify(tol_mm, preserve_topology=True)
            if not g2.is_empty and g2.is_valid:
                g = g2
        out.append(Region(r.name, r.rgb, g, r.order))
    return out, (tw, th)


def clip_to_tile(regions, col, row, cols, rows, pitch, face, margin):
    """Extract this tile's share of the artwork, in tile-local view mm."""
    uc = (col - (cols - 1) / 2.0) * pitch
    vc = (row - (rows - 1) / 2.0) * pitch
    half = face / 2.0 - margin
    cell = box(-half, -half, half, half)
    out = []
    for r in regions:
        g = affinity.translate(r.geom, -uc, -vc).intersection(cell)
        if not g.is_empty and g.area > 1e-6:
            out.append(Region(r.name, r.rgb, g, r.order, r.slot))
    return out


def to_world(geom, mirror):
    """View space (u right, v down) -> tile XY.

    The tile's decorated face is at z=0 with the retention hooks rising in +z,
    so the face is seen from -z.  Looking from -z, screen-right is -X and
    screen-down is -Y, which makes the mapping (u,v) -> (-u,-v).  That is a
    180 deg rotation, not a mirror, so the artwork is not reversed.
    --mirror flips X for anyone printing the tile the other way up.
    """
    sx = 1.0 if mirror else -1.0
    return affinity.scale(geom, sx, -1.0, origin=(0, 0))


# ============================================================================
# solids
# ============================================================================

def extrude(geom, z0, z1):
    polys = [geom] if isinstance(geom, Polygon) else list(geom.geoms)
    meshes = []
    for p in polys:
        if p.is_empty or p.area <= 1e-9:
            continue
        try:
            m = trimesh.creation.extrude_polygon(p, height=(z1 - z0))
        except Exception:
            m = trimesh.creation.extrude_polygon(p.buffer(0), height=(z1 - z0))
        m.apply_translation([0, 0, z0])
        meshes.append(m)
    if not meshes:
        return None
    return trimesh.util.concatenate(meshes)


def boolean(op, meshes):
    return trimesh.boolean.boolean_manifold(meshes, operation=op)


def build_tile(base, inks, depth):
    """base minus all ink prisms, plus one solid per ink color."""
    cutters = []
    for g in inks:
        m = extrude(g, -EPS, depth)
        if m is not None:
            cutters.append(m)
    if not cutters:
        return base.copy(), []
    allcut = cutters[0] if len(cutters) == 1 else boolean("union", cutters)
    body = boolean("difference", [base, allcut])
    parts = []
    for c in cutters:
        parts.append(boolean("intersection", [base, c]))
    return body, parts


# ============================================================================
# checks
# ============================================================================

def _thin_report(geom, w):
    """Morphological opening: anything that cannot survive erode-then-dilate by
    w/2 is narrower than w. Returns (area_lost, area_total, n_components_lost)."""
    polys = [geom] if isinstance(geom, Polygon) else list(getattr(geom, "geoms", []))
    polys = [p for p in polys if not p.is_empty and p.area > 1e-9]
    if not polys:
        return 0.0, 0.0, 0
    total = sum(p.area for p in polys)
    lost_area, lost_n = 0.0, 0
    for p in polys:
        o = p.buffer(-w / 2.0, join_style=2).buffer(w / 2.0, join_style=2)
        if o.is_empty:
            lost_area += p.area
            lost_n += 1
        else:
            lost_area += max(0.0, p.area - o.area)
    return lost_area, total, lost_n


def feature_report(ink, face, margin, nozzle):
    """Two failure modes, both worth catching before a 40 minute print:
    ink strokes thinner than the nozzle, and body-colored gaps thinner than
    the nozzle (which close up and blur the artwork)."""
    msgs = []
    la, ta, ln = _thin_report(ink, nozzle)
    if ta > 0 and la / ta > 0.02:
        msgs.append(f"{la/ta*100:.0f}% of ink is thinner than the {nozzle} mm nozzle"
                    + (f", {ln} shape(s) vanish entirely" if ln else ""))
    half = face / 2.0 - margin
    gaps = box(-half, -half, half, half).difference(ink)
    lg, tg, gn = _thin_report(gaps, nozzle)
    if tg > 0 and lg / tg > 0.02:
        msgs.append(f"{lg/tg*100:.0f}% of the body-color gaps are thinner than "
                    f"{nozzle} mm and will close up")
    return msgs


# ============================================================================
# 3MF  (Bambu Studio / OrcaSlicer project format)
# ============================================================================

_CT = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>"""

_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"""


def norm_hex(c):
    """'#abc' / 'abc' / '#AABBCC' -> '#AABBCC'. Raises ValueError otherwise."""
    t = str(c).strip().lstrip("#")
    if len(t) == 3:
        t = "".join(ch * 2 for ch in t)
    if len(t) != 6 or any(ch not in "0123456789abcdefABCDEF" for ch in t):
        raise ValueError(f"not a hex color: {c!r}")
    return "#" + t.upper()


def write_3mf(path, objects, title="tilegen", filaments=None):
    """objects: list of (name, [(part_name, mesh, extruder), ...], (x, y)).

    Each object becomes one Bambu object made of parts; each part carries its
    own filament index.  IDs matter: <part id> must equal the mesh object's id
    or the slicer silently assigns the wrong filament.

    filaments: optional [(color_or_None, type), ...] indexed from filament 1.
    When given, a Metadata/project_settings.config is written so the slicer
    opens with the colors already set instead of just numbered slots.
    """
    m, cfg = [], []
    m.append('<?xml version="1.0" encoding="UTF-8"?>')
    m.append('<model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
             'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">')
    m.append(' <metadata name="Application">BambuStudio-01.10.01.50</metadata>')
    m.append(' <metadata name="BambuStudio:3mfVersion">1</metadata>')
    m.append(f' <metadata name="Title">{escape(title)}</metadata>')
    m.append(' <resources>')

    cfg.append('<?xml version="1.0" encoding="UTF-8"?>')
    cfg.append('<config>')

    nid, build = 1, []
    for oname, parts, (px, py) in objects:
        ids = []
        for pname, mesh, ext in parts:
            v, f = mesh.vertices, mesh.faces
            m.append(f'  <object id="{nid}" type="model">')
            m.append('   <mesh>')
            m.append('    <vertices>')
            m.extend('     <vertex x="%.6f" y="%.6f" z="%.6f"/>' % tuple(p) for p in v)
            m.append('    </vertices>')
            m.append('    <triangles>')
            m.extend('     <triangle v1="%d" v2="%d" v3="%d"/>' % tuple(t) for t in f)
            m.append('    </triangles>')
            m.append('   </mesh>')
            m.append('  </object>')
            ids.append((nid, pname, ext))
            nid += 1
        cid = nid; nid += 1
        m.append(f'  <object id="{cid}" type="model">')
        m.append('   <components>')
        for i, _, _ in ids:
            m.append(f'    <component objectid="{i}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>')
        m.append('   </components>')
        m.append('  </object>')
        build.append(f'  <item objectid="{cid}" '
                     f'transform="1 0 0 0 1 0 0 0 1 {px:.4f} {py:.4f} 0" printable="1"/>')

        cfg.append(f'  <object id="{cid}">')
        cfg.append(f'    <metadata key="name" value="{escape(oname)}"/>')
        cfg.append('    <metadata key="extruder" value="1"/>')
        for k, (i, pname, ext) in enumerate(ids):
            cfg.append(f'    <part id="{i}" subtype="normal_part">')
            cfg.append(f'      <metadata key="name" value="{escape(pname)}"/>')
            cfg.append('      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>')
            cfg.append('      <metadata key="source_object_id" value="0"/>')
            cfg.append(f'      <metadata key="source_volume_id" value="{k}"/>')
            cfg.append(f'      <metadata key="extruder" value="{ext}"/>')
            cfg.append('      <mesh_stat edges_fixed="0" degenerate_facets="0" '
                       'facets_removed="0" facets_reversed="0" backwards_edges="0"/>')
            cfg.append('    </part>')
        cfg.append('  </object>')

    m.append(' </resources>')
    m.append(' <build>')
    m.extend(build)
    m.append(' </build>')
    m.append('</model>')
    cfg.append('</config>')

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _CT)
        z.writestr("_rels/.rels", _RELS)
        z.writestr("3D/3dmodel.model", "\n".join(m))
        z.writestr("Metadata/model_settings.config", "\n".join(cfg))
        if filaments:
            # Filament COLOR is project scope, not model scope: model_settings
            # carries only the slot number ("this part is filament 2"), and
            # there is no color key anywhere in it. Bambu accepts a
            # project_settings.config holding just these two arrays -- it does
            # not need the ~557 keys a slicer-saved project writes.
            # "filament_colour" is Bambu's spelling of their own key. It is
            # wire format, not prose -- do not Americanize it.
            z.writestr("Metadata/project_settings.config", json.dumps({
                "filament_colour": [c or "" for c, _ in filaments],
                "filament_type": [t for _, t in filaments],
            }, indent=2))


# ============================================================================
# preview
# ============================================================================

TILE_BG = (0x3c, 0x3c, 0x40)


def _lum(rgb):
    def f(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (f(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _contrast(a, b):
    la, lb = _lum(a), _lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def display_color(rgb, bg=TILE_BG, target=3.0):
    """Keep the artwork's hue but push lightness until it is clearly visible.

    Only lightness moves, so hue relationships between regions survive -- which
    matters for anyone reading the preview without full color discrimination.
    Distinguishing regions never depends on telling red from green.
    """
    if _contrast(rgb, bg) >= target:
        return rgb
    h, l, s = colorsys.rgb_to_hls(*[c / 255.0 for c in rgb])
    best, best_c = rgb, _contrast(rgb, bg)
    for cand_l in [x / 100 for x in range(0, 101, 2)]:
        cand = tuple(int(round(c * 255)) for c in colorsys.hls_to_rgb(h, cand_l, s))
        c = _contrast(cand, bg)
        if c > best_c:
            best, best_c = cand, c
        if c >= target and cand_l > l:
            return cand
    return best


def render_preview(out_png, regions, cols, rows, pitch, face, margin, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Polygon as MplPoly, Rectangle

    W, H = cols * pitch, rows * pitch
    bg = "#%02x%02x%02x" % TILE_BG
    fig, ax = plt.subplots(figsize=(max(3.4, W / 11), max(3.4, H / 11 + 0.5)), dpi=190)
    ax.set_facecolor("#141416"); fig.patch.set_facecolor("#141416")

    for r in range(rows):
        for c in range(cols):
            uc = (c - (cols - 1) / 2) * pitch
            vc = (r - (rows - 1) / 2) * pitch
            ax.add_patch(Rectangle((uc - face / 2, vc - face / 2), face, face,
                                   facecolor=bg, edgecolor="#0a0a0c", lw=1.0, zorder=1))

    def draw(g, color, z):
        polys = [g] if isinstance(g, Polygon) else list(getattr(g, "geoms", []))
        for p in polys:
            if p.is_empty:
                continue
            ax.add_patch(MplPoly(np.array(p.exterior.coords), closed=True,
                                 facecolor=color, edgecolor="none", zorder=z))
            for ring in p.interiors:
                ax.add_patch(MplPoly(np.array(ring.coords), closed=True,
                                     facecolor=bg, edgecolor="none", zorder=z + 0.1))

    half = face / 2 - margin
    legend = []
    for n, r in enumerate(regions):
        shown = display_color(r.rgb)
        legend.append((r.name, "#%02x%02x%02x" % shown, shown != r.rgb))
        clipped = []
        for rr in range(rows):
            for cc in range(cols):
                uc = (cc - (cols - 1) / 2) * pitch
                vc = (rr - (rows - 1) / 2) * pitch
                cell = box(uc - half, vc - half, uc + half, vc + half)
                g = r.geom.intersection(cell)
                if not g.is_empty:
                    clipped.append(g)
        if clipped:
            draw(unary_union(clipped), "#%02x%02x%02x" % shown, 2 + n * 0.01)

    pad = max(3, W * 0.06)
    ax.set_xlim(-W / 2 - pad, W / 2 + pad)
    ax.set_ylim(H / 2 + pad * 1.9, -H / 2 - pad)     # v down == as seen on the panel
    ax.set_aspect("equal"); ax.axis("off")
    ax.set_title(title, color="#e8e8ea", fontsize=9, pad=8)

    x = -W / 2
    y = H / 2 + pad * 1.15
    for i, (name, col, adj) in enumerate(legend):
        ax.add_patch(Rectangle((x, y), 2.4, 2.4, facecolor=col, edgecolor="#e8e8ea",
                               lw=0.4, zorder=5, clip_on=False))
        ax.text(x + 3.2, y + 1.9, f"filament {i+2}  {name}" + ("  (lightened)" if adj else ""),
                color="#c9c9cd", fontsize=6.0, zorder=5, clip_on=False)
        x += max(W / max(len(legend), 1), 24)
    ax.add_patch(Rectangle((-W / 2, y - 4.2), 2.4, 2.4, facecolor=bg,
                           edgecolor="#e8e8ea", lw=0.4, zorder=5, clip_on=False))
    ax.text(-W / 2 + 3.2, y - 2.3, "filament 1  tile body", color="#c9c9cd",
            fontsize=6.0, zorder=5, clip_on=False)

    fig.savefig(out_png, facecolor=fig.get_facecolor(), bbox_inches="tight")
    plt.close(fig)


# ============================================================================
# CLI
# ============================================================================

def _openscad_supports_backend(exe):
    """True if this OpenSCAD accepts --backend (added alongside Manifold)."""
    import subprocess
    try:
        h = subprocess.run([exe, "--help"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    return "--backend" in (h.stdout + h.stderr)


def ensure_base(scad, cached, force=False, tile_type="blank"):
    import subprocess, shutil
    if cached.exists() and not force:
        return trimesh.load(str(cached))
    if not scad.exists():
        raise SystemExit(
            f"{scad} missing. It includes the tile base from a git submodule; "
            f"fetch it with:\n    git submodule update --init")
    exe = shutil.which("openscad") or shutil.which("OpenSCAD")
    if not exe:
        raise SystemExit(f"{cached} missing and OpenSCAD not found. Install OpenSCAD "
                         f"or restore the cached base mesh.")
    cached.parent.mkdir(parents=True, exist_ok=True)
    # Render with CGAL, not the Manifold backend that OpenSCAD now defaults to.
    # On the tile base Manifold exports 472 facets that do not close into a
    # solid (the hook cut-outs come out with unmerged vertices); trimesh's
    # boolean engine then refuses the mesh with "Not all meshes are volumes!".
    # CGAL renders the same solid -- volume agrees to 5 decimal places -- as a
    # clean watertight 332-facet mesh.
    cmd = [exe, "-o", str(cached), "-D", f'tg_base="{tile_type}"',
           "-D", "$colorize_elements=false"]
    if _openscad_supports_backend(exe):
        cmd.append("--backend=CGAL")
    cmd.append(str(scad))
    subprocess.run(cmd, check=True, capture_output=True)
    mesh = trimesh.load(str(cached))
    if not mesh.is_watertight:
        raise SystemExit(
            f"OpenSCAD rendered {cached} but the mesh is not watertight "
            f"({len(mesh.faces)} faces), so the boolean stage would fail. "
            f"This is an OpenSCAD export problem, not a tilegen one -- try a "
            f"different OpenSCAD build, or restore the cached mesh with "
            f"'git checkout -- {cached.name}'.")
    return mesh


def main(argv=None):
    here = FsPath(__file__).resolve().parent
    ap = argparse.ArgumentParser(
        prog="tilegen",
        description="Framework Desktop tiles from any SVG or image, as multi-color parts.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=CREDITS)
    ap.add_argument("art", nargs="?", help="SVG, PNG, JPG or WEBP")
    ap.add_argument("-o", "--out", default="out", help="output directory (default: out)")
    ap.add_argument("--grid", default="1x1",
                    help="COLSxROWS, e.g. 1x1, 2x2, 3x7 (full panel). Default 1x1")
    ap.add_argument("--depth", type=float, default=0.6,
                    help="inlay depth in mm (default 0.6 = 3 layers at 0.2)")
    ap.add_argument("--colors", type=int, default=2,
                    help="colors to quantize a raster to (default 2)")
    ap.add_argument("--threshold", type=float, default=None,
                    help="raster: fixed 0-255 threshold instead of Otsu")
    ap.add_argument("--fit", choices=["contain", "cover", "stretch"], default="contain")
    ap.add_argument("--scale", type=float, default=100.0, help="extra scale %% (default 100)")
    ap.add_argument("--rotate", type=float, default=0.0, help="rotate artwork, degrees")
    ap.add_argument("--margin", type=float, default=0.0,
                    help="keep-out from each tile edge, mm (default 0)")
    ap.add_argument("--bleed", type=float, default=0.0,
                    help="oversize artwork past the panel, mm, to avoid edge slivers")
    ap.add_argument("--fill-rule", choices=["nonzero", "evenodd"], default=None,
                    help="override the SVG's own fill-rule")
    ap.add_argument("--background", default="auto",
                    help="which color becomes the bare tile body: auto (default), "
                         "none, a region index, or #RRGGBB")
    ap.add_argument("--keep-empty", action="store_true",
                    help="still emit a blank tile for grid cells with no artwork")
    ap.add_argument("--invert", action="store_true", help="swap ink and background")
    ap.add_argument("--mirror", action="store_true",
                    help="mirror artwork (only if you print the tile face-up)")
    ap.add_argument("--tolerance", type=float, default=0.02,
                    help="curve simplification in mm (default 0.02, ~1/20 of a "
                         "nozzle). Lower = smoother and much larger files")
    ap.add_argument("--nozzle", type=float, default=0.4, help="for thin-feature warnings")
    ap.add_argument("--layer", type=float, default=0.2, help="layer height, for depth advice")
    ap.add_argument("--pitch", type=float, default=PITCH, help=f"tile pitch (default {PITCH})")
    ap.add_argument("--face", type=float, default=TILE, help=f"tile face size (default {TILE})")
    ap.add_argument("--embed-filaments", action="store_true",
                    help="write filament colors into the 3MF so the slicer "
                         "opens with them already assigned")
    ap.add_argument("--body-color", default=None, metavar="HEX",
                    help="color of filament 1, the tile body, for "
                         "--embed-filaments (default: left unset)")
    ap.add_argument("--filament-type", default="PLA", metavar="TYPE",
                    help="filament type recorded for every slot with "
                         "--embed-filaments (default: PLA)")
    ap.add_argument("--no-3mf", action="store_true", help="skip the 3MF, emit STLs only")
    ap.add_argument("--no-stl", action="store_true", help="skip per-part STLs")
    ap.add_argument("--no-preview", action="store_true")
    ap.add_argument("--plate-gap", type=float, default=4.0, help="gap between tiles on the plate")
    ap.add_argument("--plate-origin", type=float, nargs=2, default=(128.0, 128.0),
                    help="plate center for the 3MF (default 128 128, an A1/P1 bed)")
    ap.add_argument("--base", choices=sorted(BASES), default="blank",
                    help="which tile base to carve into (default: blank). "
                         "frame/horizontal/cross/grid have open faces -- "
                         "artwork over an opening has nothing to print into")
    ap.add_argument("--rebuild-base", action="store_true", help="re-render the tile base")
    ap.add_argument("--credits", action="store_true", help="print attribution and exit")
    a = ap.parse_args(argv)

    if a.credits:
        print(CREDITS); return 0
    if not a.art:
        ap.error("artwork file required")

    try:
        cols, rows = (int(x) for x in a.grid.lower().split("x"))
    except Exception:
        ap.error("--grid must look like 3x7")

    if a.body_color:
        try:
            a.body_color = norm_hex(a.body_color)
        except ValueError as e:
            ap.error(str(e))

    art = FsPath(a.art)
    if not art.exists():
        raise SystemExit(f"no such file: {art}")

    base = ensure_base(here / "bases" / "tilegen_bases.scad",
                       here / "assets" / BASES[a.base],
                       force=a.rebuild_base, tile_type=a.base)

    if art.suffix.lower() == ".svg":
        regions = load_svg(art, fill_rule=a.fill_rule)
        src = "svg"
    else:
        regions = load_raster(art, n_colors=a.colors, threshold=a.threshold)
        src = "raster"
    if not regions:
        raise SystemExit("no filled artwork found in that file")

    regions = resolve_overlaps(regions)

    bgi = pick_background(regions, a.background)
    if bgi is not None:
        print(f"  background {regions[bgi].name} -> bare tile body "
              f"(filament 1); override with --background none")
        regions = [r for i, r in enumerate(regions) if i != bgi]
        if not regions:
            raise SystemExit("everything was background; try --background none")

    if a.invert:
        u = unary_union([r.geom for r in regions])
        minx, miny, maxx, maxy = u.bounds
        frame = box(minx, miny, maxx, maxy)
        regions = [Region("inverted", (255, 255, 255), frame.difference(u), 0)]

    # drop the largest region when it is a full-bleed background: printing the
    # whole face in a second color is just a differently colored tile.
    regions, (canvas_w, canvas_h) = fit_transform(
        regions, cols, rows, a.pitch, a.face, a.margin, a.bleed,
        a.fit, a.rotate, a.scale, a.tolerance)
    canvas = box(-canvas_w / 2, -canvas_h / 2, canvas_w / 2, canvas_h / 2)
    placed_area = sum(r.geom.area for r in regions)
    outside_area = sum(r.geom.difference(canvas).area for r in regions)

    # Pin each color to a filament slot now, while the full set is still in
    # hand. After this point regions get clipped per tile and any tile may see
    # only a subset.
    for _i, _r in enumerate(regions):
        _r.slot = _i

    outdir = FsPath(a.out); outdir.mkdir(parents=True, exist_ok=True)
    stem = art.stem.replace(" ", "_")

    if a.depth > SAFE_DEPTH:
        print(f"  ! depth {a.depth} mm is past the {SAFE_DEPTH} mm solid zone; "
              f"the pocket may break into the hook cut-outs")
    n_layers = a.depth / a.layer
    if abs(n_layers - round(n_layers)) > 1e-6:
        print(f"  ! depth {a.depth} mm is {n_layers:.2f} layers at {a.layer} mm; "
              f"round to {round(n_layers)*a.layer:.2f} mm for a clean color boundary")

    print(f"  {src}: {len(regions)} color region(s) -> {cols}x{rows} tile(s), "
          f"{a.depth} mm deep, {a.base} base")
    if a.base in OPEN_FACE:
        print(f"  ! the {a.base} base has an open face. Artwork over an opening "
              f"has no material to carve, so it does not print there, and what "
              f"remains is split into one fragment per opening -- measured 28 "
              f"fragments for the example logo on 'cross'. Fragments narrower "
              f"than the mesh tolerance can come out non-watertight; slice-check "
              f"before committing a long print, or use --base blank.")

    objects, made, kept_area = [], 0, 0.0
    gap = a.face + a.plate_gap
    for r in range(rows):
        for c in range(cols):
            inks = clip_to_tile(regions, c, r, cols, rows, a.pitch, a.face, a.margin)
            tag = stem if (cols == 1 and rows == 1) else f"{stem}_r{r}c{c}"
            if not inks:
                if a.keep_empty:
                    print(f"  + {tag}: blank tile (no artwork in this cell)")
                    if not a.no_stl:
                        base.export(outdir / f"{tag}_body.stl")
                    px = a.plate_origin[0] + (c - (cols - 1) / 2) * gap
                    py = a.plate_origin[1] - (r - (rows - 1) / 2) * gap
                    objects.append((tag, [("body", base, 1)], (px, py)))
                    made += 1
                else:
                    print(f"  - {tag}: no artwork in this cell, skipped")
                continue
            kept_area += sum(x.geom.area for x in inks)
            world = [to_world(x.geom, a.mirror) for x in inks]
            body, parts = build_tile(base, world, a.depth)

            print(f"  + {tag}: body {body.volume:7.1f} mm3, {len(parts)} ink part(s)")
            for msg in feature_report(unary_union(world), a.face, a.margin, a.nozzle):
                print(f"      ! {msg}")

            plist = [("body", body, 1)]
            for p, reg in zip(parts, inks):
                plist.append((f"ink_{reg.slot+1}_{reg.name}", p, reg.slot + 2))
            if not a.no_stl:
                body.export(outdir / f"{tag}_body.stl")
                for nm, mesh, _ in plist[1:]:
                    mesh.export(outdir / f"{tag}_{nm}.stl")
            px = a.plate_origin[0] + (c - (cols - 1) / 2) * gap
            py = a.plate_origin[1] - (r - (rows - 1) / 2) * gap
            objects.append((tag, plist, (px, py)))
            made += 1

    if not made:
        raise SystemExit("no tiles produced")

    if placed_area > 0:
        # Two different losses. Artwork past the canvas edge is a real crop you
        # can fix. Artwork that lands in the ~0.1 mm gaps between tile faces is
        # physics, not a setting.
        outside = outside_area / placed_area
        seam = max(0.0, (placed_area - outside_area - kept_area) / placed_area)
        if outside > 0.005 and a.fit != "cover" and a.bleed == 0:
            print(f"  ! {outside*100:.1f}% of the artwork runs past the tile area and "
                  f"was cropped -- lower --scale or --margin")
        if seam > 0.03:
            print(f"  . {seam*100:.1f}% of the artwork falls in the seams between "
                  f"tiles (unavoidable; the gap is {a.pitch - a.face:.2f} mm)")

    if not a.no_3mf:
        name = f"{stem}.3mf" if made == 1 else f"{stem}_{cols}x{rows}.3mf"
        filaments = None
        if a.embed_filaments:
            # Slot 1 is the body, whose color is whatever spool you load, so
            # it stays blank unless named. Slots 2+ follow region slot order,
            # which is exactly what the parts were assigned above.
            cols_hex = [a.body_color] + ["#%02x%02x%02x" % r.rgb for r in regions]
            filaments = [(norm_hex(c) if c else None, a.filament_type)
                         for c in cols_hex]
        write_3mf(outdir / name, objects, title=stem, filaments=filaments)
        print(f"  = {outdir/name}  ({made} object(s), filament 1 = body, 2+ = ink)")
        if filaments:
            shown = ", ".join(f"{i+1}={c or 'unset'}"
                              for i, (c, _) in enumerate(filaments))
            print(f"      filaments embedded ({a.filament_type}): {shown}")

    if not a.no_preview:
        png = outdir / f"{stem}_preview.png"
        render_preview(png, regions, cols, rows, a.pitch, a.face, a.margin,
                       f"{stem}  -  {cols}x{rows}  -  as seen on the panel")
        print(f"  = {png}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
