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

/** Region contours -> a CrossSection, with the SVG fill rule applied. */
export function regionToCrossSection(region) {
  const {CrossSection} = manifold();
  return new CrossSection(region.contours, region.fillRule);
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
 * Takes and returns CrossSections; inputs are consumed.
 */
export function resolveOverlaps(sections) {
  const {CrossSection} = manifold();
  const out = [];
  for (let i = 0; i < sections.length; i++) {
    const later = sections.slice(i + 1);
    let g = sections[i];
    if (later.length) {
      const u = CrossSection.union(later);
      const cut = CrossSection.difference(g, u);
      u.delete();
      g.delete();
      g = cut;
    }
    if (!g.isEmpty()) out.push(g);
    else g.delete();
  }
  return out;
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
    secs = secs.map((s) => s.translate([-cx, -cy]).rotate(rotate)
                              .translate([cx, cy]));
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
  const out = secs.map((s) => {
    let g = s.translate([-cx, -cy]).scale([sx, sy]);
    if (tolMm > 0) {
      // Simplify in millimeters, not artwork units: flattening fine enough
      // for a 512-unit viewBox is thousands of times finer than a printer
      // resolves, and every extra point becomes triangles.
      g = g.simplify(tolMm);
    }
    return g;
  });
  return {sections: out, canvas: [tw, th]};
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
  } catch {
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
  if (!inks.length) return {body: base, parts: []};

  const cutters = inks.map((ink) => ({
    slot: ink.slot,
    hexColor: ink.hexColor,
    solid: ink.section.extrude(depth + EPS).translate([0, 0, -EPS]),
  }));

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
  return {body, parts};
}
