// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// The warnings that tell you a tile will not print the way it looks on screen,
// ported from tilegen.py's feature_report. These are worth more than they
// look: they are the difference between finding out now and finding out after
// a forty minute print.

import {manifold} from './pipeline.js';

// shapely's default mitre_limit, which tilegen.py relies on implicitly.
const MITER_LIMIT = 5.0;

/**
 * Morphological opening: anything that cannot survive erode-then-dilate by
 * w/2 is narrower than w.
 *
 * Miter joins with limit 5, matching shapely's join_style=2 and its default
 * mitre_limit in the Python. Round joins would eat real area at every convex
 * corner and inflate the loss on artwork that is perfectly printable.
 *
 * The percentage will not match the CLI's exactly, and is not tuned to.
 * shapely offsets through GEOS and this goes through Clipper2, and on the
 * example logo at an exaggerated 2 mm nozzle they report 17% and 25%. The
 * miter limit dominates that gap (25.8% at limit 2, 13.1% at 100), so a value
 * could be fitted to match on one input and would be wrong on the next.
 * Matching the Python's PARAMETER rather than its output is the honest
 * choice: this is a heuristic warning about features below the nozzle, not a
 * measurement, and at realistic nozzle sizes both implementations agree on
 * whether to warn at all.
 *
 * Returns {lost, total, vanished} in mm^2 / count.
 */
export function thinReport(section, w) {
  const parts = section.decompose();
  let lost = 0, total = 0, vanished = 0;
  try {
    for (const p of parts) {
      const a = p.area();
      if (a <= 1e-9) continue;
      total += a;
      const eroded = p.offset(-w / 2, 'Miter', MITER_LIMIT);
      const opened = eroded.offset(w / 2, 'Miter', MITER_LIMIT);
      if (opened.isEmpty()) {
        lost += a;
        vanished++;
      } else {
        lost += Math.max(0, a - opened.area());
      }
      eroded.delete();
      opened.delete();
    }
  } finally {
    parts.forEach((p) => p.delete());
  }
  return {lost, total, vanished};
}

/**
 * Two failure modes, both worth catching before you start the print: ink
 * strokes thinner than the nozzle, and body-colored GAPS thinner than the
 * nozzle, which close up and blur the artwork.
 *
 * The gap check is the one people do not think of. A logo with fine
 * counters prints as a blob not because the ink is too thin but because the
 * spaces between it are.
 */
export function featureReport(ink, face, margin, nozzle) {
  const {CrossSection} = manifold();
  const msgs = [];

  const a = thinReport(ink, nozzle);
  if (a.total > 0 && a.lost / a.total > 0.02) {
    msgs.push(`${(a.lost / a.total * 100).toFixed(0)}% of ink is thinner than ` +
              `the ${nozzle} mm nozzle` +
              (a.vanished ? `, ${a.vanished} shape(s) vanish entirely` : ''));
  }

  const half = face / 2 - margin;
  const cell = CrossSection.square([half * 2, half * 2], true);
  const gaps = CrossSection.difference(cell, ink);
  cell.delete();
  const b = thinReport(gaps, nozzle);
  gaps.delete();
  if (b.total > 0 && b.lost / b.total > 0.02) {
    msgs.push(`${(b.lost / b.total * 100).toFixed(0)}% of the body-color gaps ` +
              `are thinner than ${nozzle} mm and will close up`);
  }
  return msgs;
}

/**
 * Artwork lost to cropping, and to the seams between tiles.
 *
 * Two different losses. Artwork past the canvas edge is a real crop you can
 * fix by changing scale or margin. Artwork landing in the ~0.1 mm gaps
 * between tile faces is physics, not a setting, so it is reported differently
 * and only when it is large enough to see.
 */
export function cropReport(placedArea, outsideArea, keptArea, opts) {
  const msgs = [];
  if (!(placedArea > 0)) return msgs;
  const outside = outsideArea / placedArea;
  const seam = Math.max(0, (placedArea - outsideArea - keptArea) / placedArea);
  if (outside > 0.005 && opts.fit !== 'cover') {
    msgs.push({
      level: 'warn',
      text: `${(outside * 100).toFixed(1)}% of the artwork runs past the tile ` +
            `area and was cropped -- lower the scale or the margin`,
    });
  }
  if (seam > 0.03) {
    msgs.push({
      level: '',
      text: `${(seam * 100).toFixed(1)}% of the artwork falls in the seams ` +
            `between tiles (unavoidable; the gap is ` +
            `${(opts.pitch - opts.face).toFixed(2)} mm)`,
    });
  }
  return msgs;
}
