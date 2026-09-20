// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import {loadSVG} from './svgload.js';
import {parseSTL, exportSTL} from './stl.js';
import {write3MF} from './threemf.js';
import {
  EPS, PITCH, SAFE_DEPTH, TILE, buildTile, clipToTile, fitTransform,
  initManifold, manifold, regionToCrossSection, toWorld,
} from './pipeline.js';

const $ = (id) => document.getElementById(id);
const log = (msg, cls = '') => {
  const el = document.createElement('div');
  el.textContent = msg;
  if (cls) el.className = cls;
  $('log').appendChild(el);
};

let baseManifold = null;
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

async function loadBase() {
  const res = await fetch('../assets/tile_base.stl');
  if (!res.ok) throw new Error(`tile_base.stl: HTTP ${res.status}`);
  const {positions, indices} = parseSTL(await res.arrayBuffer());
  const {Manifold, Mesh} = manifold();
  const mesh = new Mesh({numProp: 3, vertProperties: positions, triVerts: indices});
  const man = new Manifold(mesh);
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
  // Paint the busy state before the thread disappears into geometry.
  await yieldToPaint();

  try {
    if (!svgText) throw new Error('pick an SVG first');
    if (!baseManifold) {
      progress(0.02, 'loading tile base\u2026');
      await paintTick();
      baseManifold = await loadBase();
    }

    // The canvas size is known before parsing, so the SVG can be sampled at
    // a tolerance that means 0.02 mm on the finished tile rather than 0.02 of
    // whatever unit the viewBox happens to use.
    const canvasMm = Math.hypot(
        (o.cols - 1) * o.pitch + o.face - 2 * o.margin,
        (o.rows - 1) * o.pitch + o.face - 2 * o.margin);
    progress(0.06, 'parsing SVG\u2026');
    await paintTick();
    const regions = loadSVG(svgText, {tolMm: o.tolMm, canvasMm});
    if (!regions.length) throw new Error('no filled artwork found in that file');
    log(`svg: ${regions.length} color region(s) -> ${o.cols}x${o.rows} tile(s), ` +
        `${o.depth} mm deep`);
    if (o.depth > SAFE_DEPTH) {
      log(`  ! depth ${o.depth} mm is past the ${SAFE_DEPTH} mm solid zone; ` +
          `the pocket may break into the hook cut-outs`, 'warn');
    }

    progress(0.14, 'fitting artwork to the grid\u2026');
    await paintTick();
    let secs = regions.map(regionToCrossSection);
    const {sections} = fitTransform(secs, o);
    secs.forEach((s) => s.delete());

    // Pin each color to a filament slot now, while the full set is in hand.
    // After this point regions get clipped per tile and any tile may see only
    // a subset; numbering per tile makes one color print as different
    // filaments on different tiles.
    const slots = sections.map((section, i) => ({
      section: toWorld(section, o.mirror),
      slot: i,
      hexColor: regions[i].hex,
    }));
    sections.forEach((s) => s.delete());

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
        const inks = clipToTile(slots, c, r, o);
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

        const {body, parts} = buildTile(baseManifold, inks, o.depth);
        log(`  + ${tag}: body ${body.volume().toFixed(1)} mm3, ` +
            `${parts.length} ink part(s)`);
        const plist = [{name: 'body', mesh: body, extruder: 1}];
        for (const p of parts) {
          plist.push({name: `ink_${p.slot + 1}_${p.hexColor}`, mesh: p.solid,
                      extruder: p.slot + 2});
        }
        objects.push({name: tag, pos: [px, py], parts: plist});
        inks.forEach((i) => i.section.delete());
        made++;
      }
    }
    if (!made) throw new Error('no tiles produced');

    let filaments = null;
    if (o.embed) {
      const bodyColor = $('setBody').checked ? $('bodyColor').value : '';
      filaments = [{color: bodyColor, type: o.filamentType}].concat(
          regions.map((r) => ({color: r.hex.toUpperCase(), type: o.filamentType})));
    }

    const stem = ($('file').files[0]?.name || 'tilegen').replace(/\.svg$/i, '')
                     .replace(/\s+/g, '_');
    const name = made === 1 ? `${stem}.3mf` : `${stem}_${o.cols}x${o.rows}.3mf`;
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

    drawPreview(slots, o);
    $('count').textContent = skipped
        ? `${made} of ${made + skipped} tiles — ${skipped} cell(s) had no ` +
          `artwork and were left out. Tick "blank tile for every empty cell".`
        : `${made} tile${made > 1 ? 's' : ''}`;
    $('count').className = skipped ? 'count bad' : 'count';
    log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    slots.forEach((s) => s.section.delete());
  } catch (err) {
    log(String(err && err.message || err), 'bad');
    console.error(err);
  } finally {
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
function drawPreview(slots, o) {
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

  for (let r = 0; r < o.rows; r++) {
    for (let c = 0; c < o.cols; c++) {
      const uc = (c - (o.cols - 1) / 2) * PITCH;
      const vc = (r - (o.rows - 1) / 2) * PITCH;
      g.fillStyle = '#3c3c40';
      g.strokeStyle = '#0a0a0c';
      g.lineWidth = 0.15;
      g.fillRect(uc - o.face / 2, vc - o.face / 2, o.face, o.face);
      g.strokeRect(uc - o.face / 2, vc - o.face / 2, o.face, o.face);
    }
  }

  for (const s of slots) {
    const rgb = [1, 3, 5].map((i) => parseInt(s.hexColor.substr(i, 2), 16));
    g.fillStyle = 'rgb(' + displayColor(rgb).join(',') + ')';
    g.beginPath();
    for (const ring of s.section.toPolygons()) {
      // undo toWorld's (u,v) -> (-u,-v) so the preview matches the source
      ring.forEach(([x, y], i) => {
        const u = -x, v = -y;
        if (i === 0) g.moveTo(u, v); else g.lineTo(u, v);
      });
      g.closePath();
    }
    g.fill('evenodd');
  }
  g.restore();
  cv.hidden = false;
}

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  svgText = f ? await f.text() : null;
});
$('embed').addEventListener('change', () => {
  $('filopts').hidden = !$('embed').checked;
});
$('setBody').addEventListener('change', () => {
  $('bodyopts').hidden = !$('setBody').checked;
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
