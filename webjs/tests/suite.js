// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// Differential suite: run the real browser modules and compare against
// numbers derived from tilegen.py (webjs/tests/expected.json).
//
// This imports the same files the app does. A suite that reimplemented any of
// the pipeline would pass while the app was broken, which is the whole failure
// mode it exists to prevent.

import {loadSVG} from '../src/svgload.js';
import {loadRaster} from '../src/raster.js';
import {parseSTL} from '../src/stl.js';
import {write3MF} from '../src/threemf.js';
import {featureReport} from '../src/report.js';
import {
  BASES, PITCH, TILE, buildTile, clipToTile, faceOutline, fitTransform,
  initManifold, manifold, regionToCrossSection, resolveOverlaps, toWorld,
} from '../src/pipeline.js';

const sections = [];
let cur = null;

function section(name) {
  cur = {name, checks: []};
  sections.push(cur);
}

function check(name, ok, detail = '') {
  cur.checks.push({name, ok: !!ok, detail: String(detail)});
}

/** Volumes are compared with a tolerance, so state it explicitly. */
function near(name, got, want, tol, unit = 'mm3') {
  const d = Math.abs(got - want);
  check(name, d <= tol,
        `${got.toFixed(4)} vs ${want.toFixed(4)} ${unit}, delta ${d.toFixed(5)} (tol ${tol})`);
  return d <= tol;
}

const baseCache = new Map();
async function loadBase(name) {
  if (baseCache.has(name)) return baseCache.get(name);
  const res = await fetch(`../../assets/${BASES[name]}`);
  const {positions, indices} = parseSTL(await res.arrayBuffer());
  const {Manifold, Mesh} = manifold();
  const m = new Manifold(
      new Mesh({numProp: 3, vertProperties: positions, triVerts: indices}));
  baseCache.set(name, m);
  return m;
}

/** The app's pipeline, in one place, so the suite exercises the real path. */
async function generate({baseName = 'blank', cols = 1, rows = 1, margin = 2.5,
                         fit = 'contain', regions, depth = 0.6} = {}) {
  const base = await loadBase(baseName);
  const opts = {cols, rows, pitch: PITCH, face: TILE, margin, bleed: 0, fit,
                rotate: 0, scalePct: 100, tolMm: 0.02};
  const secs = resolveOverlaps(regions.map(regionToCrossSection));
  const {sections: fitted} = fitTransform(secs, opts);
  secs.forEach((s) => s.delete());
  const slots = fitted.map((section, i) => ({section, slot: i,
                                             hexColor: regions[i].hex}));
  const outline = faceOutline(base);
  const tiles = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const inks = clipToTile(slots, c, r, opts, outline);
      if (!inks.length) continue;
      const world = inks.map((i) => ({...i, section: toWorld(i.section, false)}));
      const {body, parts} = buildTile(base, world, depth);
      tiles[`r${r}c${c}`] = {
        body: body.volume(),
        inks: parts.map((p) => p.solid.volume()),
        slots: inks.map((i) => i.slot),
        parts, bodyMesh: body,
      };
      world.forEach((i) => i.section.delete());
      inks.forEach((i) => i.section.delete());
    }
  }
  return {base, slots, outline, tiles, opts};
}

export async function run() {
  const expected = await (await fetch('./expected.json')).json();
  await initManifold();
  const {CrossSection} = manifold();
  const svgText = await (await fetch('../../examples/fuchsia.svg')).text();
  const canvasMm = Math.hypot(TILE - 5, TILE - 5);

  // ---------------------------------------------------------------- 1
  section('1. SVG geometry matches the reference implementation');
  {
    const regions = loadSVG(svgText, {tolMm: 0.02, canvasMm});
    check('one color region in the example logo', regions.length === 1,
          `${regions.length}`);
    check('fill rule read from the document', regions[0].fillRule === 'NonZero',
          regions[0].fillRule);

    const want = expected.cases.svg_1x1_blank;
    const {tiles, base} = await generate({regions});
    const got = tiles.r0c0;
    // Tight: both sides run the same kernel on the same contours, so anything
    // beyond rounding here is a real divergence.
    near('body volume', got.body, want.tiles.r0c0.body, 0.05);
    near('ink volume', got.inks[0], want.tiles.r0c0.inks[0], 0.05);
    near('body + ink reconstruct the base',
         got.body + got.inks.reduce((a, b) => a + b, 0), want.base_volume, 0.001);
    check('one ink part', got.inks.length === 1, `${got.inks.length}`);
  }

  // ---------------------------------------------------------------- 2
  section('2. every tile base agrees with the reference');
  for (const name of Object.keys(BASES)) {
    const regions = loadSVG(svgText, {tolMm: 0.02, canvasMm});
    const want = expected.cases[`svg_1x1_${name}`];
    const {tiles} = await generate({baseName: name, regions});
    const got = tiles.r0c0;
    if (!got || !want.tiles.r0c0) {
      check(`${name}: produced a tile`, false, 'no tile');
      continue;
    }
    near(`${name} body volume`, got.body, want.tiles.r0c0.body, 0.05);
    near(`${name} body + ink reconstructs its base`,
         got.body + got.inks.reduce((a, b) => a + b, 0), want.base_volume, 0.001);
  }

  // ---------------------------------------------------------------- 3
  section('3. the face outline is taken from the mesh');
  {
    const areas = {};
    for (const name of Object.keys(BASES)) {
      const o = faceOutline(await loadBase(name));
      check(`${name} yields an outline`, o !== null,
            o ? `${o.area().toFixed(2)} mm2` : 'null');
      if (o) areas[name] = +o.area().toFixed(2);
    }
    const vals = Object.values(areas);
    check('each base has a distinct face area',
          new Set(vals).size === vals.length, JSON.stringify(areas));
    check('blank has the largest face',
          areas.blank === Math.max(...vals), `${areas.blank}`);
  }

  // ---------------------------------------------------------------- 4
  section('4. full panel, tile by tile');
  {
    const panelMm = Math.hypot(2 * PITCH + TILE, 6 * PITCH + TILE);
    const regions = loadSVG(svgText, {tolMm: 0.02, canvasMm: panelMm});
    const want = expected.cases.svg_3x7_cover;
    const {tiles} = await generate({regions, cols: 3, rows: 7, margin: 0,
                                    fit: 'cover'});
    const wantKeys = Object.keys(want.tiles).sort();
    const gotKeys = Object.keys(tiles).sort();
    check('same tiles carved as the reference',
          JSON.stringify(gotKeys) === JSON.stringify(wantKeys),
          `${gotKeys.length} vs ${wantKeys.length}`);
    let worst = 0, worstAt = '';
    for (const k of wantKeys) {
      if (!tiles[k]) continue;
      const d = Math.abs(tiles[k].body - want.tiles[k].body);
      if (d > worst) { worst = d; worstAt = k; }
    }
    // 0.15 mm3 on a ~1800 mm3 tile is 0.008%. The browser samples paths
    // through getPointAtLength and svgelements computes them analytically, so
    // a flattening difference is expected -- and it scales with the artwork,
    // which on a panel is ~6x larger across than on one tile. A single tile
    // agrees to 0.02 mm3; asking a panel for the same number would be asking
    // the two libraries to round identically.
    check('every tile body volume matches', worst <= 0.15,
          `worst ${worst.toFixed(4)} mm3 at ${worstAt || 'n/a'}`);
  }

  // ---------------------------------------------------------------- 5
  section('5. filament slots are global, not per tile');
  {
    // The bug this pins: a tile only carries the colors whose artwork reaches
    // it, so numbering inks per tile made three distinct colors all print as
    // filament 2 and a multi-color panel slice in one color, silently.
    const bands = {
      rgb: [255, 0, 0], hex: '#ff0000', fillRule: 'EvenOdd', order: 0,
      contours: [[[0, 0], [100, 0], [100, 300], [0, 300]]],
    };
    const mid = {
      rgb: [0, 160, 0], hex: '#00a000', fillRule: 'EvenOdd', order: 1,
      contours: [[[100, 0], [200, 0], [200, 300], [100, 300]]],
    };
    const right = {
      rgb: [0, 0, 255], hex: '#0000ff', fillRule: 'EvenOdd', order: 2,
      contours: [[[200, 0], [300, 0], [300, 300], [200, 300]]],
    };
    const {tiles} = await generate({regions: [bands, mid, right], cols: 3,
                                    rows: 1, margin: 0, fit: 'stretch'});
    const perTile = Object.entries(tiles).map(([k, v]) => [k, v.slots]);
    check('each tile sees exactly one color', perTile.every(([, s]) => s.length === 1),
          JSON.stringify(perTile));
    const used = perTile.map(([, s]) => s[0]).sort();
    check('the three tiles use three DIFFERENT filament slots',
          new Set(used).size === used.length, `slots ${JSON.stringify(used)}`);
    check('no color lands on slot -1 or duplicates slot 0',
          used.every((s) => s >= 0), JSON.stringify(used));
  }

  // ---------------------------------------------------------------- 6
  section('6. raster input, smooth artwork');
  {
    // Large smooth features at 800 px: the case where two tracers genuinely
    // should agree, so this one is held to a tight bound.
    const blob = await (await fetch('./fixtures/blobs.png')).blob();
    const file = new File([blob], 'blobs.png', {type: 'image/png'});
    const {regions, background} = await loadRaster(file, {nColors: 2});
    const want = expected.cases.raster_blobs;
    check('regions found', regions.length === want.regions,
          `${regions.length} vs ${want.regions}`);
    check('the border color was dropped as background', background !== null,
          String(background));
    const {tiles} = await generate({regions});
    const got = tiles.r0c0;
    check('a tile was produced', !!got);
    if (got) {
      const w = want.tiles.r0c0.body;
      const rel = Math.abs(got.body - w) / w;
      check('body volume within 1% of the reference tracer', rel < 0.01,
            `${got.body.toFixed(1)} vs ${w.toFixed(1)} mm3 (${(rel * 100).toFixed(2)}%)`);
      near('body + ink reconstruct the base',
           got.body + got.inks.reduce((a, b) => a + b, 0), want.base_volume, 0.01);
    }
  }

  // ---------------------------------------------------------------- 6b
  section('6b. raster input, pathological artwork');
  {
    // 160 px of high-frequency noise: every blob is a few pixels across, so
    // marching squares putting the isoline on the half-pixel boundary shifts
    // a large perimeter relative to a small area. The two tracers are ~5%
    // apart here and that is inherent, not a defect -- so this fixture tests
    // that the pipeline SURVIVES it and stays self-consistent, which is what
    // actually matters, rather than pretending to agreement it cannot have.
    const blob = await (await fetch('./fixtures/noise.png')).blob();
    const file = new File([blob], 'noise.png', {type: 'image/png'});
    const {regions} = await loadRaster(file, {nColors: 2, background: 'none'});
    const want = expected.cases.raster_noise;
    check('both regions survive quantization', regions.length === want.regions,
          `${regions.length} vs ${want.regions}`);
    const {tiles} = await generate({regions});
    const got = tiles.r0c0;
    check('a tile was produced from noise', !!got);
    if (got) {
      const w = want.tiles.r0c0.body;
      const rel = Math.abs(got.body - w) / w;
      check('body volume in the same ballpark (<8%)', rel < 0.08,
            `${got.body.toFixed(1)} vs ${w.toFixed(1)} mm3 (${(rel * 100).toFixed(2)}%)`);
      // This is the assertion that matters, and it is exact: whatever the
      // tracer decided, the carve must still partition the base. It is what
      // caught the missing resolveOverlaps.
      near('body + ink exactly reconstruct the base',
           got.body + got.inks.reduce((a, b) => a + b, 0), want.base_volume, 0.01);
      check('more than one ink part, so overlaps are actually exercised',
            got.inks.length >= 2, `${got.inks.length} ink parts`);
    }
  }

  // ---------------------------------------------------------------- 7
  section('7. 3MF structure');
  {
    const regions = loadSVG(svgText, {tolMm: 0.02, canvasMm});
    const {tiles} = await generate({regions});
    const t = tiles.r0c0;
    const objects = [{
      name: 'tile', pos: [128, 128],
      parts: [{name: 'body', mesh: t.bodyMesh, extruder: 1}].concat(
          t.parts.map((p, i) => ({name: `ink_${p.slot + 1}_${p.hexColor}`,
                                  mesh: p.solid, extruder: p.slot + 2}))),
    }];
    const filaments = [{color: '#3C3C40', type: 'PLA'},
                       {color: '#2F2F31', type: 'PLA'}];
    const blob = await write3MF(objects, {title: 'tile', filaments});
    const buf = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder('latin1').decode(buf);
    for (const entry of ['[Content_Types].xml', '_rels/.rels',
                         '3D/3dmodel.model', 'Metadata/model_settings.config',
                         'Metadata/project_settings.config']) {
      check(`zip contains ${entry}`, text.includes(entry));
    }
    check('zip ends with a valid end-of-central-directory record',
          buf.length > 22 &&
          new DataView(buf.buffer).getUint32(buf.length - 22, true) === 0x06054b50);
    check('3MF is a plausible size', blob.size > 10000, `${blob.size} bytes`);
  }

  // ---------------------------------------------------------------- 8
  section('8. thin-feature warnings');
  {
    const regions = loadSVG(svgText, {tolMm: 0.02, canvasMm});
    const secs = regions.map(regionToCrossSection);
    const opts = {cols: 1, rows: 1, pitch: PITCH, face: TILE, margin: 2.5,
                  bleed: 0, fit: 'contain', rotate: 0, scalePct: 100,
                  tolMm: 0.02};
    const {sections: fitted} = fitTransform(secs, opts);
    secs.forEach((s) => s.delete());
    const ink = fitted[0];
    // Behavior, not percentages: GEOS and Clipper2 offset differently, so the
    // numbers are not comparable, but whether to warn at all is.
    const quiet = featureReport(ink, TILE, 2.5, 0.4);
    const loud = featureReport(ink, TILE, 2.5, 2.0);
    check('silent at a realistic 0.4 mm nozzle', quiet.length === 0,
          JSON.stringify(quiet));
    check('warns at an exaggerated 2 mm nozzle', loud.length >= 1,
          `${loud.length} message(s)`);
    check('warns about ink AND about gaps',
          loud.some((m) => m.includes('of ink')) &&
          loud.some((m) => m.includes('gaps')), JSON.stringify(loud));
  }

  return {sections};
}
