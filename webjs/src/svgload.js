// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// SVG -> filled regions, grouped by fill color.
//
// The browser is the SVG engine here: every <path>/<rect>/<circle>/... is an
// SVGGeometryElement, so getPointAtLength() flattens beziers and arcs exactly
// as the renderer would, getComputedStyle() resolves fill through CSS and
// inheritance, and getCTM() bakes in nested transforms. That replaces the
// whole of svgelements.
//
// The one thing the DOM will not do is hand back individual subpaths, and we
// need those: the fill rule is defined over a path's subpaths, so an 'o' whose
// counter is a second subpath has to arrive as two rings, not one blob. Hence
// the tokenizer below, which splits a 'd' into one absolute subpath each.

const PARAMS = {M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0};

/** Tokenize a path 'd' into {cmd, args} items, arc flags included. */
function tokenize(d) {
  const out = [];
  // Arc flags may be written unseparated ("a1 1 0 011 1"), so a plain number
  // scan mis-reads them. Track position within the command to know when the
  // next character is a single-digit flag rather than a number.
  let i = 0;
  const n = d.length;
  const ws = () => { while (i < n && /[\s,]/.test(d[i])) i++; };
  const num = () => {
    ws();
    const m = /^[+-]?(\d*\.\d+|\d+\.?)([eE][+-]?\d+)?/.exec(d.slice(i));
    if (!m) throw new Error(`bad number at ${i} in path`);
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const flag = () => {
    ws();
    const c = d[i++];
    if (c !== '0' && c !== '1') throw new Error(`bad arc flag at ${i} in path`);
    return c === '1' ? 1 : 0;
  };

  let cmd = null;
  while (true) {
    ws();
    if (i >= n) break;
    if (/[a-zA-Z]/.test(d[i])) {
      cmd = d[i++];
    } else if (cmd === null) {
      throw new Error('path does not start with a command');
    } else if (cmd === 'M') {
      cmd = 'L';          // extra pairs after a moveto are implicit linetos
    } else if (cmd === 'm') {
      cmd = 'l';
    }
    const up = cmd.toUpperCase();
    const count = PARAMS[up];
    if (count === undefined) throw new Error(`unknown path command ${cmd}`);
    const args = [];
    if (up === 'A') {
      args.push(num(), num(), num(), flag(), flag(), num(), num());
    } else {
      for (let k = 0; k < count; k++) args.push(num());
    }
    out.push({cmd, args});
    if (up === 'Z') cmd = null;
  }
  return out;
}

/** Split a 'd' string into one absolute-start subpath 'd' per subpath. */
export function splitSubpaths(d) {
  const toks = tokenize(d);
  const subs = [];
  let cur = null;
  let x = 0, y = 0, sx = 0, sy = 0;

  const push = (t) => {
    const parts = t.args.length ? ` ${t.args.join(' ')}` : '';
    cur.d += `${t.cmd}${parts}`;
  };

  for (const t of toks) {
    const up = t.cmd.toUpperCase();
    const rel = t.cmd !== up;
    if (up === 'M') {
      x = rel ? x + t.args[0] : t.args[0];
      y = rel ? y + t.args[1] : t.args[1];
      sx = x; sy = y;
      // Start the subpath with an absolute moveto so the relative commands
      // that follow resolve correctly in isolation.
      cur = {d: `M ${x} ${y}`, closed: false};
      subs.push(cur);
      continue;
    }
    if (!cur) continue;
    if (up === 'Z') {
      cur.closed = true;
      cur.d += 'Z';
      x = sx; y = sy;
      continue;
    }
    push(t);
    // Advance the current point. Only the final coordinate pair matters.
    const a = t.args;
    switch (up) {
      case 'H': x = rel ? x + a[0] : a[0]; break;
      case 'V': y = rel ? y + a[0] : a[0]; break;
      case 'A': x = rel ? x + a[5] : a[5]; y = rel ? y + a[6] : a[6]; break;
      default: {
        const px = a[a.length - 2], py = a[a.length - 1];
        x = rel ? x + px : px;
        y = rel ? y + py : py;
      }
    }
  }
  return subs;
}

/** Sample one SVGGeometryElement into a ring of [x, y] in root user space. */
function sampleElement(el, ctm, tol) {
  const total = el.getTotalLength();
  if (!(total > 0)) return null;
  // One sample per `tol` of arc length. getPointAtLength is a DOM call per
  // sample, so the tolerance has to be in the right units or this dominates
  // the whole run: see chooseTolerance.
  const steps = Math.max(3, Math.min(20000, Math.ceil(total / Math.max(tol, 1e-6))));
  const ring = [];
  let px = NaN, py = NaN;
  for (let k = 0; k <= steps; k++) {
    const p = el.getPointAtLength((k / steps) * total);
    const X = ctm ? ctm.a * p.x + ctm.c * p.y + ctm.e : p.x;
    const Y = ctm ? ctm.b * p.x + ctm.d * p.y + ctm.f : p.y;
    if (Math.abs(X - px) > 1e-9 || Math.abs(Y - py) > 1e-9) ring.push([X, Y]);
    px = X; py = Y;
  }
  if (ring.length > 1) {
    const a = ring[0], b = ring[ring.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) ring.pop();
  }
  return ring.length >= 3 ? ring : null;
}

function parseColor(css) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css || '');
  if (!m) return null;
  return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
}

export function hex(rgb) {
  return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse SVG source into regions: [{rgb, hex, contours, fillRule, order}].
 *
 * contours are rings of [x, y] in the SVG's own user units, y down.
 * Regions are grouped by fill color, in first-seen order, exactly as
 * tilegen.py's load_svg does, so the filament slot order matches.
 */
/**
 * Pick a sampling tolerance in SVG user units that lands near `tolMm` on the
 * finished tile.
 *
 * The naive choice -- a fixed tolerance in user units -- is wrong by whatever
 * the viewBox happens to be. A 512-unit viewBox scaled to a 23.5 mm tile makes
 * one unit 0.046 mm, so sampling every 0.02 units is 20x finer than the 0.02
 * mm the geometry is simplified to afterwards: tens of thousands of points
 * per ring, every one a DOM call, all of them discarded moments later.
 *
 * So measure the artwork cheaply first (64 samples an element is plenty for a
 * bounding box) and scale the tolerance by how much it is about to shrink.
 */
function chooseTolerance(els, tolMm, canvasMm) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const {el, ctm} of els) {
    const total = el.getTotalLength();
    if (!(total > 0)) continue;
    for (let k = 0; k <= 64; k++) {
      const p = el.getPointAtLength((k / 64) * total);
      const X = ctm ? ctm.a * p.x + ctm.c * p.y + ctm.e : p.x;
      const Y = ctm ? ctm.b * p.x + ctm.d * p.y + ctm.f : p.y;
      if (X < minx) minx = X;
      if (X > maxx) maxx = X;
      if (Y < miny) miny = Y;
      if (Y > maxy) maxy = Y;
    }
  }
  if (!Number.isFinite(minx)) return tolMm;
  const diagUnits = Math.hypot(maxx - minx, maxy - miny);
  if (!(diagUnits > 0) || !(canvasMm > 0)) return tolMm;
  // units per mm, times the mm we care about
  return Math.max(diagUnits * (tolMm / canvasMm), 1e-6);
}

export function loadSVG(text, {tolMm = 0.02, canvasMm = 0, fillRule = null} = {}) {
  const host = document.createElement('div');
  // Must be in the document for getComputedStyle/getCTM/getTotalLength to
  // work, but must not be display:none or layout never happens.
  host.setAttribute('style',
      'position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden');
  host.innerHTML = text;
  document.body.appendChild(host);

  try {
    const svg = host.querySelector('svg');
    if (!svg) throw new Error('no <svg> element found in that file');

    const buckets = new Map();
    let order = 0;

    const drawable = [];
    for (const el of svg.querySelectorAll(
             'path,rect,circle,ellipse,polygon,polyline,line')) {
      if (typeof el.getTotalLength !== 'function') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const rgb = parseColor(cs.fill);
      if (!rgb) continue;                       // fill:none or unresolvable
      const fo = parseFloat(cs.fillOpacity);
      if (Number.isFinite(fo) && fo === 0) continue;
      drawable.push({
        el, rgb, ctm: el.getCTM(),
        rule: fillRule || (cs.fillRule === 'evenodd' ? 'EvenOdd' : 'NonZero'),
      });
    }

    const tol = chooseTolerance(drawable, tolMm, canvasMm);

    for (const {el, rgb, ctm, rule} of drawable) {

      let rings = [];
      if (el.tagName.toLowerCase() === 'path') {
        const d = el.getAttribute('d') || '';
        let subs;
        try {
          subs = splitSubpaths(d);
        } catch (err) {
          console.warn('path split failed, treating as one ring:', err.message);
          subs = null;
        }
        if (subs && subs.length > 1) {
          for (const s of subs) {
            const tmp = document.createElementNS(
                'http://www.w3.org/2000/svg', 'path');
            tmp.setAttribute('d', s.d);
            el.parentNode.insertBefore(tmp, el);
            const r = sampleElement(tmp, ctm, tol);
            tmp.remove();
            if (r) rings.push(r);
          }
        } else {
          const r = sampleElement(el, ctm, tol);
          if (r) rings.push(r);
        }
      } else {
        const r = sampleElement(el, ctm, tol);
        if (r) rings.push(r);
      }
      if (!rings.length) continue;

      const key = rgb.join(',');
      if (!buckets.has(key)) {
        buckets.set(key, {rgb, hex: hex(rgb), contours: [], fillRule: rule,
                          order: order++});
      }
      const b = buckets.get(key);
      // A path with an even-odd rule cannot be merged into a nonzero bucket
      // without changing what it means, so the first rule seen for a color
      // wins and a conflict is reported rather than silently applied.
      if (b.fillRule !== rule) {
        console.warn(`fill-rule conflict for ${b.hex}: keeping ${b.fillRule}`);
      }
      b.contours.push(...rings);
    }

    return [...buckets.values()].sort((a, b) => a.order - b.order);
  } finally {
    host.remove();
  }
}
