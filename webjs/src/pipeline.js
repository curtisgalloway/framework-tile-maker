// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// The tile pipeline, ported from tilegen.py. The numbers here are the whole
// point of the port being faithful, so they are stated once and shared.

export const PITCH = 28.60;   // tile center-to-center, mm
export const TILE = 28.50;    // printed tile outer size
export const SAFE_DEPTH = 1.60;
export const EPS = 0.05;

// Tile bases, mapped to their cached render. Built by
// bases/tilegen_bases.scad; see the repo README for why the vendored
// tile_base.scad's own crosshatch cannot simply be parameterised.
export const BASES = {
  blank: 'tile_base.stl',
  grid: 'tile_base_grid.stl',
  cross: 'tile_base_cross.stl',
  horizontal: 'tile_base_horizontal.stl',
  frame: 'tile_base_frame.stl',
};

// Bases whose face is not solid: artwork over an opening has no material to
// carve, so it does not print there.
export const OPEN_FACE = new Set(['grid', 'cross', 'horizontal', 'frame']);

let M = null;   // the manifold-3d module, once loaded

export async function initManifold() {
  if (M) return M;
  const mod = await import(
      'https://cdn.jsdelivr.net/npm/manifold-3d@3.5.3/manifold.js');
  const wasm = await mod.default();
  wasm.setup();
  M = wasm;
  return M;
}

export function manifold() {
  if (!M) throw new Error('manifold not initialized');
  return M;
}

/**
 * One color region -> a CrossSection.
 *
 * A region that carries `shapes` is built one shape at a time and unioned,
 * because the fill rule is defined over the subpaths of a SINGLE path and
 * never across paths. Two same-colored paths always union -- even when one
 * sits inside the other wound the opposite way, which under one shared
 * nonzero evaluation would cancel to a hole instead.
 *
 * `contours` alone is the fallback for regions that have no shapes, which is
 * what the raster path produces: its rings come out of one marching-squares
 * pass over one mask, so they really are a single even-odd figure.
 */
export function regionToCrossSection(region) {
  const {CrossSection} = manifold();
  const shapes = region.shapes;
  if (!shapes || !shapes.length) {
    return new CrossSection(region.contours, region.fillRule);
  }
  if (shapes.length === 1) {
    return new CrossSection(shapes[0].contours,
                            shapes[0].fillRule || region.fillRule);
  }
  const parts = shapes.map(
      (sh) => new CrossSection(sh.contours, sh.fillRule || region.fillRule));
  const u = CrossSection.union(parts);
  parts.forEach((x) => x.delete());
  return u;
}

/**
 * Painter's algorithm: later artwork wins where regions overlap.
 *
 * Not optional. Quantized raster regions are disjoint by pixel, but each
 * region's contours are traced independently and marching squares puts the
 * isoline on the half-pixel boundary, so neighbours both claim the boundary
 * strip. Without this the overlap is extruded twice: the parts intersect in
 * the 3MF, and body + ink stops reconstructing the base -- measured +2.22 mm3
 * on the test fixture, which is how this was caught.
 *
 * Takes CrossSections and consumes them. Returns {sections, kept}, where
 * kept[i] is the index in the INPUT array that sections[i] came from --
 * required because a fully covered region drops out and shortens the result.
 */
export function resolveOverlaps(sections) {
  const {CrossSection} = manifold();
  const n = sections.length;
  const out = [];
  const kept = [];
  // Everything painted after i, accumulated from the end. Re-unioning the
  // tail for every i is O(n^2) boolean ops, which was invisible while the
  // input was one entry per COLOR and is not once it is one entry per shape:
  // a few hundred paths is a normal SVG. Built backwards it is n-1 unions
  // total, and each one only ever adds a single section.
  const after = new Array(n).fill(null);
  for (let i = n - 2; i >= 0; i--) {
    after[i] = after[i + 1]
        ? CrossSection.union(after[i + 1], sections[i + 1])
        // No copy() on CrossSection; a zero translate is the cheap clone.
        // It has to be a clone: `after` is freed at the end, and aliasing an
        // input section here would free the caller's geometry with it.
        : sections[i + 1].translate([0, 0]);
  }
  for (let i = 0; i < n; i++) {
    let g = sections[i];
    if (after[i]) {
      const cut = CrossSection.difference(g, after[i]);
      g.delete();
      g = cut;
    }
    // A region completely covered by a later one drops out here, which
    // SHORTENS the array. `kept` records which original region each survivor
    // came from: without it the caller's regions[i] lookup silently shifts
    // and every colour after the drop is attached to the wrong geometry.
    if (!g.isEmpty()) {
      out.push(g);
      kept.push(i);
    } else {
      g.delete();
    }
  }
  for (const a of after) if (a) a.delete();
  return {sections: out, kept};
}

/**
 * Regions -> one CrossSection per surviving color, painted in document order.
 *
 * The painter's algorithm has to run over SHAPES, not colors. Grouping by
 * color first and resolving those pins every shape of a color to the first
 * place that color appears, so a backdrop and a highlight drawn in the same
 * color become one thing that sits underneath everything else -- and a mark
 * deliberately drawn on top of the other color is erased by it. Measured on a
 * two-color logo: the star drawn last, in the backdrop color, vanished
 * completely.
 *
 * So: flatten to shapes, resolve in paint order, then regroup what survived
 * onto its color. Color order is unchanged (first appearance), because that
 * is what a filament slot is assigned from.
 *
 * Returns {sections, regions}, index-aligned, with any color that ended up
 * fully covered dropped from both.
 */
export function resolveRegions(regions) {
  const {CrossSection} = manifold();
  const items = [];
  regions.forEach((region, ri) => {
    const shapes = region.shapes && region.shapes.length
        ? region.shapes
        : [{contours: region.contours, fillRule: region.fillRule,
            z: region.order}];
    for (const sh of shapes) {
      items.push({ri, z: sh.z ?? region.order, contours: sh.contours,
                  fillRule: sh.fillRule || region.fillRule});
    }
  });
  // Stable by construction within a color; sorting interleaves the colors
  // back into the order the document draws them.
  items.sort((a, b) => a.z - b.z);

  const resolved = resolveOverlaps(items.map(
      (it) => new CrossSection(it.contours, it.fillRule)));

  const byColor = new Map();
  resolved.sections.forEach((sec, i) => {
    const ri = items[resolved.kept[i]].ri;
    if (!byColor.has(ri)) byColor.set(ri, []);
    byColor.get(ri).push(sec);
  });

  const sections = [];
  const live = [];
  for (let ri = 0; ri < regions.length; ri++) {
    const pieces = byColor.get(ri);
    if (!pieces) continue;
    let g = pieces[0];
    if (pieces.length > 1) {
      g = CrossSection.union(pieces);
      pieces.forEach((x) => x.delete());
    }
    sections.push(g);
    live.push(regions[ri]);
  }
  return {sections, regions: live};
}

/**
 * Which section, if any, is the backdrop: the one that owns the outside edge.
 *
 * A full-bleed backdrop is a color the tile can simply BE. Printing it as
 * inlay instead carves the whole face away and hands back a part the size of
 * the tile, burning a filament slot and a lot of plastic to reproduce
 * something the body could have been all along.
 *
 * The test is ownership of a thin rim just inside the ARTWORK'S OWN outline,
 * which is what "the color you see around the edge" means geometrically.
 * Deliberately not the bounding box: a rounded triangle fills barely half of
 * its box, all of it near one corner, so a box-frame test scores the backdrop
 * of that logo at a fraction of the rim it plainly owns and finds nothing.
 *
 * The threshold is high on purpose. Artwork that merely touches the edge is
 * not a backdrop, and a wrong guess here silently deletes a color.
 *
 * Returns an index into `sections`, or -1 for "nothing qualifies".
 */
export function pickBackground(sections, minShare = 0.75) {
  const {CrossSection} = manifold();
  if (sections.length < 2) return -1;      // dropping the only color = no art
  const all = CrossSection.union(sections);
  const b = all.bounds();
  const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1];
  // Rim thickness as a fraction of the artwork, so it is resolution- and
  // unit-independent: thin enough to mean "the edge", thick enough to survive
  // the flattening tolerance.
  const t = Math.min(w, h) * 0.02;
  if (!(w > 0) || !(h > 0) || !(t > 0)) { all.delete(); return -1; }

  const inset = all.offset(-t, 'Round');
  const rim = CrossSection.difference(all, inset);
  all.delete();
  inset.delete();
  const rimArea = rim.area();
  let best = -1, bestShare = minShare;
  if (rimArea > 0) {
    sections.forEach((sec, i) => {
      const hit = CrossSection.intersection(sec, rim);
      const share = hit.area() / rimArea;
      hit.delete();
      if (share > bestShare) { bestShare = share; best = i; }
    });
  }
  rim.delete();
  return best;
}

/**
 * Scale artwork into view-space millimeters, origin at panel center.
 *
 * The canvas is NOT cols*pitch. Outer tiles contribute only their face and
 * every tile loses `margin` at each edge, so sizing to cols*pitch overscales
 * by (pitch - face) + 2*margin and silently crops. This is the single easiest
 * thing to get wrong in the whole pipeline.
 */
export function fitTransform(sections, opts) {
  const {cols, rows, pitch, face, margin, bleed, fit, rotate, scalePct,
         tolMm = 0} = opts;
  const {CrossSection} = manifold();

  let secs = sections;
  if (rotate) {
    const all = CrossSection.union(secs);
    const b = all.bounds();
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
    all.delete();
    // Chaining orphans each intermediate: translate() and rotate() each
    // return a NEW CrossSection, and only the last handle is kept. Dead code
    // today (every caller pins rotate: 0) but wrong the moment it is used.
    secs = secs.map((sec) => {
      const a = sec.translate([-cx, -cy]);
      const b2 = a.rotate(rotate);
      a.delete();
      const c = b2.translate([cx, cy]);
      b2.delete();
      return c;
    });
  }

  const all = CrossSection.union(secs);
  const b = all.bounds();
  all.delete();
  const aw = Math.max(b.max[0] - b.min[0], 1e-9);
  const ah = Math.max(b.max[1] - b.min[1], 1e-9);

  const tw = (cols - 1) * pitch + face - 2 * margin + bleed;
  const th = (rows - 1) * pitch + face - 2 * margin + bleed;
  if (tw <= 0 || th <= 0) {
    throw new Error(`margin ${margin} leaves no room on a ${face} mm tile`);
  }

  let sx, sy;
  if (fit === 'contain') {
    sx = sy = Math.min(tw / aw, th / ah);
  } else if (fit === 'cover') {
    sx = sy = Math.max(tw / aw, th / ah);
  } else {
    sx = tw / aw; sy = th / ah;
  }
  sx *= scalePct / 100; sy *= scalePct / 100;

  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  const out = secs.map((sec) => {
    // Every step returns a NEW CrossSection and WASM memory is not garbage
    // collected, so each intermediate has to be freed explicitly. Written as
    // a chain this leaked two per colour region on every single run.
    const moved = sec.translate([-cx, -cy]);
    let g = moved.scale([sx, sy]);
    moved.delete();
    if (tolMm > 0) {
      // Simplify in millimeters, not artwork units: flattening fine enough
      // for a 512-unit viewBox is thousands of times finer than a printer
      // resolves, and every extra point becomes triangles.
      const simplified = g.simplify(tolMm);
      g.delete();
      g = simplified;
    }
    return g;
  });
  return {sections: out, canvas: [tw, th]};
}

// Segments per full circle for the round dilation in widenGaps. Left to
// itself, Manifold sizes circles by edge length, which gives a 0.3 mm radius
// about four segments; the polygon is inscribed, so the dilation falls short
// of the width it was asked for wherever the widened gap curves.
const ROUND_SEGMENTS = 48;

/**
 * Widen every body-colored gap narrower than `minGap` mm, by trimming the ink
 * on both sides of it. Gaps already at least `minGap` wide are not touched.
 *
 * The artwork prints face down, so the gaps land on the first layer, whose
 * line width (0.5 mm on a Bambu 0.4 nozzle) is wider than the nozzle. A body
 * wall narrower than one line is not laid down cleanly, and the ink lines on
 * either side spill into it: measured on a two-color logo whose 0.4-0.5 mm
 * curves sliced with ink specks along their length.
 *
 * Shrinking ALL the ink by a fixed amount cannot guarantee a minimum: any
 * V-shaped gap narrows to zero at its point, so the amount always comes out
 * as the maximum. Instead the gaps are sorted into width bands by morphological
 * opening -- anything that cannot hold a `hi`-wide disc is narrower than `hi`
 * -- and each band is dilated by just enough to reach `minGap`. A gap of width
 * t in [lo, hi) grows to t + (minGap - lo), so the result lands within one
 * step of minGap: even along a curve whose width wanders, instead of lumpy
 * where one fixed dilation would have started and stopped. (Within, not
 * above: where a widened stretch meets a curving flank, spots a few hundredths
 * of a mm across measure up to one step short.)
 *
 * Only body gaps are widened. Two different ink colors touching is not a gap
 * and must not grow a body-colored seam between them, so the gaps are taken
 * against the union of all ink.
 *
 * Takes and consumes `sections` (view-space mm). Returns {sections, removed}:
 * the trimmed sections, index-aligned with the input (a section may come back
 * empty), and the ink area removed in mm^2.
 */
export function widenGaps(sections, minGap, step = 0.05) {
  const {CrossSection} = manifold();
  if (!(minGap > 0) || !sections.length) return {sections, removed: 0};
  const MITER = 5.0;
  const NOISE = 0.02;  // mm; narrower than this is flattening error, not art

  const all = CrossSection.union(sections);
  if (all.isEmpty()) { all.delete(); return {sections, removed: 0}; }
  const b = all.bounds();
  // The body continues past the artwork, so the frame must too. Taking gaps
  // against the artwork's own bounding box made the strip between an edge
  // shape and the box look thin, and trimmed ink that was never near a gap.
  const pad = 2 * minGap + 1;
  const box = CrossSection.square(
      [b.max[0] - b.min[0] + 2 * pad, b.max[1] - b.min[1] + 2 * pad], true);
  const frame = box.translate([(b.min[0] + b.max[0]) / 2,
                               (b.min[1] + b.max[1]) / 2]);
  box.delete();
  const gaps = CrossSection.difference(frame, all);
  frame.delete();
  all.delete();

  const cuts = [];
  try {
    for (let lo = 0; lo < minGap - 1e-9; lo += step) {
      const hi = Math.min(lo + step, minGap);
      // thin(hi) holds every gap narrower than hi, the narrower bands
      // included. Those already got a larger dilation on an earlier pass, so
      // dilating the whole set again by the smaller amount adds nothing wrong
      // and saves a difference per band.
      // Round, unlike the warnings in report.js: a miter opening grows the
      // sharp corners of the eroded gap back into a pinch, counting as wide
      // enough a strip that is not, and that strip is then never widened.
      const eroded = gaps.offset(-hi / 2, 'Round', 2, ROUND_SEGMENTS);
      const opened = eroded.offset(hi / 2, 'Round', 2, ROUND_SEGMENTS);
      eroded.delete();
      const raw = CrossSection.difference(gaps, opened);
      opened.delete();
      // Opening a flattened curve is not exact: it leaves hairline residue,
      // a few microns wide, along edges that are nowhere near thin. Dilated
      // below, every one of those bit a round notch out of the ink, and a
      // wide curve came back scalloped and shedding ink islands -- measured
      // at 27 new sliver rings on a two-color logo.
      //
      // So judge each connected piece whole: keep it if ANY part of it is
      // wider than NOISE, drop it if it is hairline all the way through.
      // Opening the pieces by NOISE instead also shaved the tapering tail
      // off every real band, and a gap curving round a pinch then came out
      // 0.50 mm wide against a 0.60 minimum.
      const pieces = raw.decompose();
      raw.delete();
      const real = [];
      for (const p of pieces) {
        const core = p.offset(-NOISE / 2, 'Miter', MITER);
        if (!core.isEmpty() && core.area() > 1e-9) real.push(p); else p.delete();
        core.delete();
      }
      if (!real.length) continue;
      const thin = real.length === 1 ? real[0] : CrossSection.union(real);
      if (real.length > 1) real.forEach((p) => p.delete());
      cuts.push(thin.offset((minGap - lo) / 2, 'Round', 2, ROUND_SEGMENTS));
      thin.delete();
    }
  } finally {
    gaps.delete();
  }
  if (!cuts.length) return {sections, removed: 0};

  const cut = cuts.length === 1 ? cuts[0] : CrossSection.union(cuts);
  if (cuts.length > 1) cuts.forEach((c) => c.delete());
  let removed = 0;
  const out = sections.map((sec) => {
    const trimmed = CrossSection.difference(sec, cut);
    removed += Math.max(0, sec.area() - trimmed.area());
    sec.delete();
    return trimmed;
  });
  cut.delete();
  return {sections: out, removed};
}

/**
 * View space (u right, v down) -> tile XY.
 *
 * The decorated face is at z=0 with hooks rising in +z, so it is seen from
 * -z, where screen-right is -X and screen-down is -Y. That makes (u,v) ->
 * (-u,-v): a 180 deg rotation, NOT a mirror, so artwork is never reversed.
 */
export function toWorld(section, mirror) {
  return section.scale([mirror ? 1 : -1, -1]);
}

/**
 * The material actually present at the decorated face, in view space.
 *
 * Slicing the base just above z=0 is the only honest way to draw the face: a
 * blank tile is a full square, the striped and frame bases are not, and
 * drawing a square for them previews a tile that will never be printed.
 *
 * Returned in VIEW space: the section is tile XY, and the face is seen from
 * -z where (u, v) = (-x, -y), the same 180 deg mapping toWorld applies in
 * reverse.
 */
export function faceOutline(base, z = 0.02) {
  try {
    const sec = base.slice(z);
    if (sec.isEmpty()) { sec.delete(); return null; }
    const flipped = sec.scale([-1, -1]);
    sec.delete();
    return flipped;
  } catch (err) {
    // A silent null is indistinguishable from "this base has no face
    // material", and the caller then clips ink to the bare cell instead. The
    // printed body is unaffected (buildTile re-clips in 3D), but the preview,
    // the thin-feature warnings and the crop bookkeeping all quietly degrade,
    // which is the opposite of what this function is for.
    console.warn('faceOutline failed; preview and warnings will be ' +
                 'approximate for this base:', err);
    return null;
  }
}

/** This tile's share of the artwork, in tile-local view mm. */
export function clipToTile(slots, col, row, opts, outline = null) {
  const {cols, rows, pitch, face, margin} = opts;
  const {CrossSection} = manifold();
  const uc = (col - (cols - 1) / 2) * pitch;
  const vc = (row - (rows - 1) / 2) * pitch;
  const half = face / 2 - margin;
  let cell = CrossSection.square([half * 2, half * 2], true);
  if (outline) {
    // Ink only exists where the base has material. Intersecting here rather
    // than after extrusion keeps the 2D and the 3D telling the same story,
    // and keeps the preview honest for open-faced bases.
    const clipped = CrossSection.intersection(cell, outline);
    cell.delete();
    cell = clipped;
  }

  const out = [];
  for (const s of slots) {
    const moved = s.section.translate([-uc, -vc]);
    const g = CrossSection.intersection(moved, cell);
    moved.delete();
    if (!g.isEmpty() && g.area() > 1e-6) {
      out.push({...s, section: g});     // slot index rides along, see below
    } else {
      g.delete();
    }
  }
  cell.delete();
  return out;
}

/**
 * base minus every ink prism, plus one solid per ink color.
 *
 * Returns {body, parts:[{slot, mesh}]}. Each part's filament is slot + 2, and
 * `slot` is the color's index in the FULL artwork, assigned before tiles were
 * cut. A per-tile index makes one color print as filament 2 on one tile and 3
 * on the next, so a multi-color panel silently slices in a single color.
 */
export function buildTile(base, inks, depth) {
  const {Manifold} = manifold();
  // NOTE: `body` here IS the caller's base, not a fresh mesh -- the only
  // return path where that is true. bodyIsBase says so explicitly, because a
  // caller that follows the obvious contract and deletes `body` would free
  // the caller's own (cached) base.
  if (!inks.length) return {body: base, parts: [], bodyIsBase: true};

  const cutters = inks.map((ink) => {
    // extrude() and translate() each return a new Manifold; chaining dropped
    // the extrude result on the floor -- one full mesh per ink per tile, so
    // ~63 leaked meshes for a three-colour 3x7 panel.
    const raw = ink.section.extrude(depth + EPS);
    const solid = raw.translate([0, 0, -EPS]);
    raw.delete();
    return {slot: ink.slot, hexColor: ink.hexColor, solid};
  });

  const all = cutters.length === 1
      ? cutters[0].solid
      : Manifold.union(cutters.map((c) => c.solid));
  const body = Manifold.difference(base, all);
  if (cutters.length > 1) all.delete();

  const parts = cutters.map((c) => ({
    slot: c.slot,
    hexColor: c.hexColor,
    solid: Manifold.intersection(base, c.solid),
  }));
  for (const c of cutters) c.solid.delete();
  return {body, parts, bodyIsBase: false};
}
