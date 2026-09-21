// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// PNG/JPEG/WEBP -> filled regions, in the same shape loadSVG returns, so the
// rest of the pipeline cannot tell the difference.
//
// This is the part with no library doing the work for us. tilegen.py leans on
// OpenCV for Otsu, k-means and findContours; the browser has none of those, so
// each is here. They are small, and being explicit about them is worth more
// than a megabyte of opencv.js.

/** Decode any browser-supported image into ImageData. */
export async function decode(file, maxSide = 1400) {
  const bmp = await createImageBitmap(file);
  // Downscale first. Contour count scales with resolution, and a 4000px photo
  // buys nothing on a 28.5 mm tile: one pixel would be 0.007 mm, far below
  // what a 0.4 mm nozzle resolves, while costing ~20x the tracing work.
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = new OffscreenCanvas(w, h);
  const g = cv.getContext('2d', {willReadFrequently: true});
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return g.getImageData(0, 0, w, h);
}

/** Otsu's threshold on a grayscale histogram; returns 0..255. */
export function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best;
}

function toGray(img) {
  const {data, width, height} = img;
  const g = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    g[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
  }
  return g;
}

/**
 * k-means in RGB, seeded deterministically.
 *
 * Deterministic on purpose: the same image must quantize the same way every
 * run, or the filament a color maps to would shuffle between runs and a
 * reprint would not match the first print. Seeding by even spacing along the
 * luminance order gives that, and converges in a handful of passes.
 */
export function kmeans(img, k, iters = 12) {
  const {data} = img;
  const n = data.length / 4;
  const px = new Float64Array(n * 3);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 3) {
    px[p] = data[i]; px[p + 1] = data[i + 1]; px[p + 2] = data[i + 2];
  }
  const order = Array.from({length: n}, (_, i) => i)
      .sort((a, b) => (px[a * 3] + px[a * 3 + 1] + px[a * 3 + 2]) -
                      (px[b * 3] + px[b * 3 + 1] + px[b * 3 + 2]));
  const cent = new Float64Array(k * 3);
  for (let c = 0; c < k; c++) {
    const i = order[Math.min(n - 1, Math.floor((c + 0.5) * n / k))];
    cent[c * 3] = px[i * 3];
    cent[c * 3 + 1] = px[i * 3 + 1];
    cent[c * 3 + 2] = px[i * 3 + 2];
  }

  const label = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = px[i * 3] - cent[c * 3];
        const dg = px[i * 3 + 1] - cent[c * 3 + 1];
        const db = px[i * 3 + 2] - cent[c * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; bi = c; }
      }
      if (label[i] !== bi) { label[i] = bi; moved++; }
    }
    const sum = new Float64Array(k * 3), cnt = new Float64Array(k);
    for (let i = 0; i < n; i++) {
      const c = label[i];
      sum[c * 3] += px[i * 3];
      sum[c * 3 + 1] += px[i * 3 + 1];
      sum[c * 3 + 2] += px[i * 3 + 2];
      cnt[c]++;
    }
    for (let c = 0; c < k; c++) {
      if (!cnt[c]) continue;
      cent[c * 3] = sum[c * 3] / cnt[c];
      cent[c * 3 + 1] = sum[c * 3 + 1] / cnt[c];
      cent[c * 3 + 2] = sum[c * 3 + 2] / cnt[c];
    }
    if (!moved) break;
  }
  const colors = [];
  for (let c = 0; c < k; c++) {
    colors.push([Math.round(cent[c * 3]), Math.round(cent[c * 3 + 1]),
                 Math.round(cent[c * 3 + 2])]);
  }
  return {label, colors};
}

/**
 * Marching squares on a binary mask -> closed contours, in pixel coordinates.
 *
 * Chosen over emitting one rectangle per pixel (which Clipper2 would happily
 * union) because the isoline cuts corners at 45 degrees instead of leaving a
 * one-pixel staircase on every diagonal edge. At a 1400 px source on a 23 mm
 * tile a pixel is ~0.017 mm, so a staircase would sit right at the tolerance
 * the geometry is simplified to and survive it.
 *
 * Outer boundaries and holes come out wound oppositely, which is exactly what
 * an even-odd fill rule wants, so nesting needs no extra work.
 */
export function contours(mask, w, h) {
  // Sample the mask on a (w+1) x (h+1) grid of cell corners.
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : mask[y * w + x];
  const key = (x, y, e) => `${x},${y},${e}`;
  // For each cell, marching-squares case -> list of [entryEdge, exitEdge].
  // Edges: 0 top, 1 right, 2 bottom, 3 left.
  const SEGS = {
    1: [[3, 2]], 2: [[2, 1]], 3: [[3, 1]], 4: [[1, 0]],
    5: [[3, 0], [1, 2]], 6: [[2, 0]], 7: [[3, 0]], 8: [[0, 3]],
    9: [[0, 2]], 10: [[0, 1], [2, 3]], 11: [[0, 1]], 12: [[1, 3]],
    13: [[1, 2]], 14: [[2, 3]],
  };
  const mid = (x, y, e) => (
      e === 0 ? [x + 0.5, y] :
      e === 1 ? [x + 1, y + 0.5] :
      e === 2 ? [x + 0.5, y + 1] : [x, y + 0.5]);

  // Build a directed edge map: from a point to the next point.
  const next = new Map();
  for (let y = -1; y <= h; y++) {
    for (let x = -1; x <= w; x++) {
      const tl = at(x, y), tr = at(x + 1, y);
      const br = at(x + 1, y + 1), bl = at(x, y + 1);
      const idx = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      const segs = SEGS[idx];
      if (!segs) continue;
      for (const [a, b] of segs) {
        next.set(key(x, y, a), {to: key(x, y, b), pt: mid(x, y, b),
                                from: mid(x, y, a)});
      }
    }
  }

  const out = [];
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring = [];
    let cur = start;
    let guard = 0;
    while (!seen.has(cur) && next.has(cur) && guard++ < next.size + 4) {
      seen.add(cur);
      const step = next.get(cur);
      ring.push(step.from);
      // Move to the neighbouring cell across the exit edge.
      const [cx, cy, ce] = cur.split(',').map(Number);
      const eOut = Number(step.to.split(',')[2]);
      let nx = cx, ny = cy, nEdge;
      if (eOut === 0) { ny = cy - 1; nEdge = 2; }
      else if (eOut === 1) { nx = cx + 1; nEdge = 3; }
      else if (eOut === 2) { ny = cy + 1; nEdge = 0; }
      else { nx = cx - 1; nEdge = 1; }
      cur = key(nx, ny, nEdge);
    }
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}

const hex = (rgb) =>
    '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');

/**
 * Decode an image into regions, matching loadSVG's return shape.
 *
 * `background` follows tilegen.py: 'auto' drops the region that touches the
 * border most, so the tile body shows through instead of printing a whole
 * extra filament's worth of backdrop.
 */
export async function loadRaster(file, {nColors = 2, background = 'auto'} = {}) {
  const img = await decode(file);
  const {width: w, height: h} = img;
  let label, colors;

  if (nColors <= 2) {
    // Two colors is a threshold problem, not a clustering one, and Otsu is
    // both faster and more stable on text and logos than k-means with k=2.
    const gray = toGray(img);
    const t = otsu(gray);
    label = new Int32Array(w * h);
    const sums = [[0, 0, 0, 0], [0, 0, 0, 0]];
    for (let i = 0, p = 0; p < w * h; i += 4, p++) {
      const c = gray[p] > t ? 1 : 0;
      label[p] = c;
      sums[c][0] += img.data[i];
      sums[c][1] += img.data[i + 1];
      sums[c][2] += img.data[i + 2];
      sums[c][3]++;
    }
    colors = sums.map((s) => s[3]
        ? [Math.round(s[0] / s[3]), Math.round(s[1] / s[3]), Math.round(s[2] / s[3])]
        : [0, 0, 0]);
  } else {
    ({label, colors} = kmeans(img, nColors));
  }

  // Which label owns the border? That is the background candidate.
  const edge = new Array(colors.length).fill(0);
  for (let x = 0; x < w; x++) { edge[label[x]]++; edge[label[(h - 1) * w + x]]++; }
  for (let y = 0; y < h; y++) { edge[label[y * w]]++; edge[label[y * w + w - 1]]++; }
  let bg = -1;
  if (background === 'auto') {
    bg = edge.indexOf(Math.max(...edge));
  } else if (background !== 'none') {
    const want = background.replace('#', '').toLowerCase();
    bg = colors.findIndex((c) => hex(c).slice(1) === want);
  }

  const regions = [];
  for (let c = 0; c < colors.length; c++) {
    if (c === bg) continue;
    const mask = new Uint8Array(w * h);
    let any = 0;
    for (let p = 0; p < w * h; p++) {
      if (label[p] === c) { mask[p] = 1; any++; }
    }
    if (!any) continue;
    const rings = contours(mask, w, h).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    regions.push({
      rgb: colors[c], hex: hex(colors[c]), contours: rings,
      // Marching squares winds outers and holes oppositely, so even-odd gives
      // holes -- and islands inside holes -- the right fill.
      fillRule: 'EvenOdd',
      order: regions.length,
      pixels: any,
    });
  }
  // Largest first, so filament 2 is the most prominent color.
  regions.sort((a, b) => b.pixels - a.pixels);
  regions.forEach((r, i) => { r.order = i; });
  return {regions, background: bg >= 0 ? hex(colors[bg]) : null};
}
