// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import {loadSVG} from './svgload.js';
import {loadRaster} from './raster.js';
import {cropReport, featureReport} from './report.js';
import {parseSTL, exportSTL} from './stl.js';
import {write3MF} from './threemf.js';
import {
  BASES, EPS, OPEN_FACE, PITCH, SAFE_DEPTH, TILE, buildTile, clipToTile,
  faceOutline, fitTransform, initManifold, manifold, regionToCrossSection,
  resolveOverlaps, toWorld,
} from './pipeline.js';

const $ = (id) => document.getElementById(id);
const log = (msg, cls = '') => {
  const el = document.createElement('div');
  el.textContent = msg;
  if (cls) el.className = cls;
  $('log').appendChild(el);
};

const baseCache = new Map();
let artFile = null;
let svgText = null;
let lastFiles = [];
let busy = false;

/**
 * Hand the browser a frame so queued DOM changes actually paint.
 *
 * Everything below this point is synchronous CPU work, and the main thread is
 * the only thread it has. Setting a label and then meshing for seven seconds
 * means the label is not painted until the meshing ends -- which is why the
 * button appeared to do nothing at all when clicked. requestAnimationFrame
 * gets us to just before a paint; the nested setTimeout returns control after
 * it, so the next chunk of work starts on a screen that is already updated.
 */
function yieldToPaint() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    // rAF lands us just before a paint, which is what we want when visible.
    requestAnimationFrame(() => setTimeout(finish, 0));
    // But rAF is PAUSED in a hidden or fully occluded tab, so on its own it
    // hangs the whole run the moment you switch tabs. The timeout is the
    // guarantee: yield either way, paint when there is someone to paint for.
    setTimeout(finish, 50);
  });
}

/**
 * Yield only when there is someone to yield for.
 *
 * A hidden tab pauses rAF *and* clamps setTimeout to roughly once a second,
 * so pausing once per tile there turns a 7 s panel into a 30 s one to update
 * a progress bar nobody can see. When hidden, run flat out.
 */
function paintTick() {
  if (document.visibilityState !== 'visible') return Promise.resolve();
  return yieldToPaint();
}

function setBusy(on) {
  busy = on;
  const go = $('go');
  go.disabled = on;
  $('golabel').textContent = on ? 'Generating\u2026' : 'Generate';
  const sp = go.querySelector('.spinner');
  if (on && !sp) {
    const el = document.createElement('span');
    el.className = 'spinner';
    go.prepend(el);
  } else if (!on && sp) {
    sp.remove();
  }
  $('progress').hidden = !on;
  if (!on) progress(0, '');
}

function progress(frac, text) {
  $('fill').style.width = `${Math.round(frac * 100)}%`;
  $('phase').textContent = text;
}

async function loadBase(name) {
  if (baseCache.has(name)) return baseCache.get(name);
  const file = BASES[name];
  if (!file) throw new Error(`unknown base '${name}'`);
  const res = await fetch(`../assets/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const {positions, indices} = parseSTL(await res.arrayBuffer());
  const {Manifold, Mesh} = manifold();
  const man = new Manifold(
      new Mesh({numProp: 3, vertProperties: positions, triVerts: indices}));
  baseCache.set(name, man);
  return man;
}

function opts() {
  return {
    cols: +$('cols').value,
    rows: +$('rows').value,
    pitch: PITCH,
    face: TILE,
    margin: +$('margin').value,
    bleed: 0,
    fit: $('fit').value,
    rotate: 0,
    scalePct: 100,
    tolMm: 0.02,
    depth: +$('depth').value,
    mirror: $('mirror').checked,
    keepEmpty: $('keepEmpty').checked,
    embed: $('embed').checked,
    filamentType: $('filamentType').value,
    base: $('base').value,
    nozzle: +$('nozzle').value,
    colors: +$('colors').value,
    background: $('background').value,
  };
}

async function generate() {
  const o = opts();
  $('log').innerHTML = '';
  lastFiles.forEach(URL.revokeObjectURL);
  lastFiles = [];
  $('files').innerHTML = '';
  // The parts <details> is a SIBLING of #files, so clearing #files alone
  // leaves last run's downloads on the page. That showed up as 43 part files
  // for a 21-tile panel, which cannot happen (42 is the ceiling).
  $('parts')?.remove();
  setBusy(true);
  progress(0, 'reading artwork…');
  const t0 = performance.now();
  // Every WASM object this run allocates, so `finally` can free them whether
  // the run finishes or throws. Manifold memory is not garbage collected, and
  // all the cleanup used to sit on the success path: one throw in write3MF
  // abandoned every tile mesh built up to that point.
  //
  // The cached tile base is deliberately NOT in here -- it is reused across
  // runs, so deleting it would be a use-after-free on the next Generate.
  const owned = [];
  const own = (x) => { if (x) owned.push(x); return x; };
  // Paint the busy state before the thread disappears into geometry.
  await yieldToPaint();

  try {
    if (!artFile) throw new Error('pick a file first');
    progress(0.02, 'loading tile base\u2026');
    await paintTick();
    const baseManifold = await loadBase(o.base);   // cached, not owned
    const outline = own(faceOutline(baseManifold));

    // The canvas size is known before parsing, so the SVG can be sampled at
    // a tolerance that means 0.02 mm on the finished tile rather than 0.02 of
    // whatever unit the viewBox happens to use.
    const canvasMm = Math.hypot(
        (o.cols - 1) * o.pitch + o.face - 2 * o.margin,
        (o.rows - 1) * o.pitch + o.face - 2 * o.margin);
    const isSVG = /\.svg$/i.test(artFile.name) ||
                  artFile.type === 'image/svg+xml';
    progress(0.06, isSVG ? 'parsing SVG\u2026' : 'quantizing image\u2026');
    await paintTick();

    let regions, droppedBg = null;
    if (isSVG) {
      regions = loadSVG(svgText, {tolMm: o.tolMm, canvasMm});
    } else {
      const res = await loadRaster(artFile,
          {nColors: o.colors, background: o.background});
      regions = res.regions;
      droppedBg = res.background;
      if (droppedBg) {
        log(`  background ${droppedBg} -> bare tile body (filament 1); ` +
            `set background to 'none' to print it`);
      }
    }
    if (!regions.length) throw new Error('no filled artwork found in that file');
    log(`${isSVG ? 'svg' : 'raster'}: ${regions.length} color region(s) -> ` +
        `${o.cols}x${o.rows} tile(s), ` +
        `${o.depth} mm deep, ${o.base} base`);
    if (OPEN_FACE.has(o.base)) {
      log(`  ! the ${o.base} base has an open face. Artwork over an opening ` +
          `has no material to carve, so it does not print there, and what ` +
          `remains is split into one fragment per opening.`, 'warn');
    }
    if (o.depth > SAFE_DEPTH) {
      log(`  ! depth ${o.depth} mm is past the ${SAFE_DEPTH} mm solid zone; ` +
          `the pocket may break into the hook cut-outs`, 'warn');
    }

    progress(0.14, 'fitting artwork to the grid\u2026');
    await paintTick();
    const resolved = resolveOverlaps(regions.map(regionToCrossSection));
    // A region wholly covered by a later one is dropped, so this list can be
    // shorter than `regions`. Everything downstream must index through
    // `kept`, never by position, or colours attach to the wrong geometry.
    const liveRegions = resolved.kept.map((k) => regions[k]);
    if (liveRegions.length < regions.length) {
      log(`  ${regions.length - liveRegions.length} color region(s) fully ` +
          `covered by later artwork and dropped`);
    }
    let secs = resolved.sections;
    const {sections} = fitTransform(secs, o);
    secs.forEach((s) => s.delete());
    sections.forEach(own);

    // Pin each color to a filament slot now, while the full set is in hand.
    // After this point regions get clipped per tile and any tile may see only
    // a subset; numbering per tile makes one color print as different
    // filaments on different tiles.
    //
    // Slots stay in VIEW space and toWorld is applied per tile after
    // clipping, matching tilegen.py. Clipping in world space happens to agree
    // on a single centred tile, because the cell is symmetric about its own
    // centre, but the cell offsets are view-space quantities -- and the face
    // outline is view space too, so mixing them would be wrong.
    const slots = sections.map((section, i) => ({
      section, slot: i, hexColor: liveRegions[i].hex,
    }));

    // Bookkeeping for the crop report: how much artwork was placed, how much
    // fell outside the usable canvas, and how much survived into tiles. The
    // difference between the last two is what the seams ate.
    const {CrossSection} = manifold();
    const canvasBox = CrossSection.square(
        [(o.cols - 1) * o.pitch + o.face - 2 * o.margin,
         (o.rows - 1) * o.pitch + o.face - 2 * o.margin], true);
    let placedArea = 0, outsideArea = 0, keptArea = 0;
    for (const sl of slots) {
      placedArea += sl.section.area();
      const out = CrossSection.difference(sl.section, canvasBox);
      outsideArea += out.area();
      out.delete();
    }
    canvasBox.delete();

    const objects = [];
    const gap = o.face + 4.0;
    let made = 0, skipped = 0;
    const total = o.cols * o.rows;
    let done = 0;

    for (let r = 0; r < o.rows; r++) {
      for (let c = 0; c < o.cols; c++) {
        // Tiles are the long pole, so this is where the bar has to move.
        // 0.18..0.85 of the run, one repaint per tile.
        progress(0.18 + 0.67 * (done / total),
                 `tile ${done + 1} of ${total}\u2026`);
        await paintTick();
        done++;
        const tag = (o.cols === 1 && o.rows === 1) ? 'tile' : `tile_r${r}c${c}`;
        const inks = clipToTile(slots, c, r, o, outline);
        const px = 128 + (c - (o.cols - 1) / 2) * gap;
        const py = 128 - (r - (o.rows - 1) / 2) * gap;

        if (!inks.length) {
          if (o.keepEmpty) {
            log(`  + ${tag}: blank tile (no artwork in this cell)`);
            objects.push({name: tag, pos: [px, py],
                          parts: [{name: 'body', mesh: baseManifold, extruder: 1}]});
            made++;
          } else {
            log(`  - ${tag}: no artwork in this cell, skipped`);
            skipped++;
          }
          continue;
        }

        const worldInks = inks.map((ink) => ({
          ...ink, section: toWorld(ink.section, o.mirror),
        }));
        for (const ink of inks) keptArea += ink.section.area();

        const {body, parts, bodyIsBase} = buildTile(baseManifold, worldInks,
                                                    o.depth);
        // bodyIsBase means buildTile handed back the cached base unchanged;
        // owning it would free the cache out from under the next run.
        if (!bodyIsBase) own(body);
        parts.forEach((pp) => own(pp.solid));
        log(`  + ${tag}: body ${body.volume().toFixed(1)} mm3, ` +
            `${parts.length} ink part(s)`);

        // Thin-feature warnings, on the view-space ink for this tile.
        const merged = CrossSection.union(inks.map((i) => i.section));
        for (const msg of featureReport(merged, o.face, o.margin, o.nozzle)) {
          log(`      ! ${msg}`, 'warn');
        }
        merged.delete();
        const plist = [{name: 'body', mesh: body, extruder: 1}];
        for (const p of parts) {
          plist.push({name: `ink_${p.slot + 1}_${p.hexColor}`, mesh: p.solid,
                      extruder: p.slot + 2});
        }
        objects.push({name: tag, pos: [px, py], parts: plist});
        worldInks.forEach((i) => i.section.delete());
        inks.forEach((i) => i.section.delete());
        made++;
      }
    }
    if (!made) throw new Error('no tiles produced');

    let filaments = null;
    if (o.embed) {
      const bodyColor = $('setBody').checked ? $('bodyColor').value : '';
      // Indexed by filament slot, and a part's extruder is slot + 2, so this
      // must follow the SURVIVING regions -- building it from the full list
      // would offset every colour after a dropped region.
      filaments = [{color: bodyColor, type: o.filamentType}].concat(
          liveRegions.map((r) => ({color: r.hex.toUpperCase(),
                                   type: o.filamentType})));
    }

    const stem = (artFile?.name || 'tilegen')
                     .replace(/\.(svg|png|jpe?g|webp)$/i, '')
                     .replace(/\s+/g, '_');
    const name = made === 1 ? `${stem}.3mf` : `${stem}_${o.cols}x${o.rows}.3mf`;
    for (const m of cropReport(placedArea, outsideArea, keptArea, o)) {
      log(`  ${m.level === 'warn' ? '!' : '.'} ${m.text}`, m.level);
    }

    progress(0.87, 'writing the 3MF\u2026');
    await paintTick();
    const blob = await write3MF(objects, {title: stem, filaments});
    addFile(name, blob, true);
    log(`  = ${name}  (${made} object(s), filament 1 = body, 2+ = ink)`);
    if (filaments) {
      log(`      filaments embedded (${o.filamentType}): ` +
          filaments.map((f, i) => `${i + 1}=${f.color || 'unset'}`).join(', '));
    }

    progress(0.94, 'exporting part STLs\u2026');
    await paintTick();
    for (const obj of objects) {
      for (const p of obj.parts) {
        addFile(`${obj.name}_${p.name}.stl`, exportSTL(p.mesh), false);
      }
    }
    progress(1, 'done');

    drawPreview(slots, o, outline);
    $('count').textContent = skipped
        ? `${made} of ${made + skipped} tiles — ${skipped} cell(s) had no ` +
          `artwork and were left out. Tick "blank tile for every empty cell".`
        : `${made} tile${made > 1 ? 's' : ''}`;
    $('count').className = skipped ? 'count bad' : 'count';
    log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } catch (err) {
    log(String(err && err.message || err), 'bad');
    console.error(err);
  } finally {
    // Unconditional: this is the only place WASM memory is released, so it
    // must run on the throwing path too.
    for (const x of owned) {
      try { x.delete(); } catch { /* already freed or torn down */ }
    }
    owned.length = 0;
    setBusy(false);
  }
}

function addFile(name, blob, main) {
  const url = URL.createObjectURL(blob);
  lastFiles.push(url);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.textContent = name;
  if (main) {
    a.className = 'main';
    $('files').appendChild(a);
  } else {
    let det = $('parts');
    if (!det) {
      det = document.createElement('details');
      det.id = 'parts';
      det.innerHTML = '<summary>individual part files</summary>' +
                      '<div class="files" id="partlist"></div>';
      $('files').after(det);
    }
    $('partlist').appendChild(a);
  }
}

const TILE_BG = [0x3c, 0x3c, 0x40];

function lum([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hslToRgb(h, l, s) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)]
      .map((v) => Math.round(v * 255));
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, l, 0];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (mx === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, l, s];
}

/**
 * Keep the artwork's hue but push lightness until it is clearly visible.
 *
 * Only lightness moves, so hue relationships between regions survive, and
 * telling two regions apart never depends on telling red from green. Without
 * this a #2f2f31 ink is invisible on the #3c3c40 tile -- which is exactly the
 * case the example file hits.
 */
function displayColor(rgb, target = 3.0) {
  if (contrast(rgb, TILE_BG) >= target) return rgb;
  const [h, l, s] = rgbToHsl(rgb);
  let best = rgb, bestC = contrast(rgb, TILE_BG);
  for (let i = 0; i <= 100; i += 2) {
    const cand = hslToRgb(h, i / 100, s);
    const c = contrast(cand, TILE_BG);
    if (c > bestC) { best = cand; bestC = c; }
    if (c >= target && i / 100 > l) return cand;
  }
  return best;
}

/** Canvas preview: the panel as seen from outside, artwork in view space. */
/** Artwork as it will actually appear: inside the tiles, on real material. */
function clipPreview(section, o, outline) {
  const {CrossSection} = manifold();
  const half = o.face / 2 - o.margin;
  const cells = [];
  for (let r = 0; r < o.rows; r++) {
    for (let c = 0; c < o.cols; c++) {
      const uc = (c - (o.cols - 1) / 2) * PITCH;
      const vc = (r - (o.rows - 1) / 2) * PITCH;
      let cell = CrossSection.square([half * 2, half * 2], true).translate([uc, vc]);
      if (outline) {
        const m = outline.translate([uc, vc]);
        const k = CrossSection.intersection(cell, m);
        cell.delete(); m.delete();
        cell = k;
      }
      cells.push(cell);
    }
  }
  const mask = CrossSection.union(cells);
  cells.forEach((c) => c.delete());
  const out = CrossSection.intersection(section, mask);
  mask.delete();
  return out;
}

function drawPreview(slots, o, outline = null) {
  const cv = $('preview');
  const W = o.cols * PITCH, H = o.rows * PITCH;
  const px = Math.min(920 / W, 620 / H) * (window.devicePixelRatio || 1);
  cv.width = Math.round(W * px);
  cv.height = Math.round(H * px);
  cv.style.width = `${Math.round(W * px / (window.devicePixelRatio || 1))}px`;
  const g = cv.getContext('2d');
  g.fillStyle = '#141416';
  g.fillRect(0, 0, cv.width, cv.height);

  // View space -> canvas. The slots hold world XY (already 180-rotated for
  // viewing from -z), so rotate back to get what the eye sees.
  g.save();
  g.translate(cv.width / 2, cv.height / 2);
  g.scale(px, px);

  // Draw the face the base really has, so an opening reads as an opening
  // rather than as tile material.
  const rings = outline ? outline.toPolygons() : null;
  for (let r = 0; r < o.rows; r++) {
    for (let c = 0; c < o.cols; c++) {
      const uc = (c - (o.cols - 1) / 2) * PITCH;
      const vc = (r - (o.rows - 1) / 2) * PITCH;
      g.strokeStyle = '#0a0a0c';
      g.lineWidth = 0.15;
      if (!rings) {
        g.fillStyle = '#3c3c40';
        g.fillRect(uc - o.face / 2, vc - o.face / 2, o.face, o.face);
      } else {
        g.fillStyle = '#0a0a0c';
        g.fillRect(uc - o.face / 2, vc - o.face / 2, o.face, o.face);
        g.fillStyle = '#3c3c40';
        g.beginPath();
        for (const ring of rings) {
          ring.forEach(([x, y], i) => {
            if (i === 0) g.moveTo(x + uc, y + vc);
            else g.lineTo(x + uc, y + vc);
          });
          g.closePath();
        }
        g.fill('evenodd');
      }
      g.strokeRect(uc - o.face / 2, vc - o.face / 2, o.face, o.face);
    }
  }

  // Slots are already view space, and so is the outline, so this draws what
  // a viewer outside the case sees with no further mapping.
  for (const s of slots) {
    const rgb = [1, 3, 5].map((i) => parseInt(s.hexColor.substr(i, 2), 16));
    g.fillStyle = 'rgb(' + displayColor(rgb).join(',') + ')';
    g.beginPath();
    const shown = clipPreview(s.section, o, outline);
    for (const ring of shown.toPolygons()) {
      ring.forEach(([x, y], i) => {
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.closePath();
    }
    shown.delete();
    g.fill('evenodd');
  }
  g.restore();
  cv.hidden = false;
}

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  artFile = f || null;
  // Only SVG needs its text up front; rasters are decoded at generate time,
  // because the decode depends on settings the user may still be changing.
  svgText = (f && (/\.svg$/i.test(f.name) || f.type === 'image/svg+xml'))
      ? await f.text() : null;
  $('rasteropts').hidden = !f || svgText !== null;
});
$('embed').addEventListener('change', () => {
  $('filopts').hidden = !$('embed').checked;
});
$('setBody').addEventListener('change', () => {
  $('bodyopts').hidden = !$('setBody').checked;
});
$('base').addEventListener('change', () => {
  $('basehint').hidden = $('base').value === 'blank';
});
$('fullpanel').addEventListener('click', () => {
  $('cols').value = 3; $('rows').value = 7;
  $('margin').value = 0; $('fit').value = 'cover';
});
// disabled alone is not quite enough: a double-click can land both events
// before the first handler has run, so re-entry is refused explicitly too.
$('go').addEventListener('click', () => { if (!busy) generate(); });

initManifold().then(() => {
  $('status').textContent = 'manifold ready — everything runs in this tab';
  $('go').disabled = false;
}).catch((err) => {
  $('status').textContent = `failed to load manifold: ${err.message}`;
  $('status').className = 'bad';
});
