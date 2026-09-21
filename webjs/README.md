<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# tilegen in the browser

The default way to use tilegen: the whole pipeline in a tab, with no Python,
no server and no install. SVG and raster both work.

```bash
python3 -m http.server 8790 --directory ..   # any static server will do
open http://127.0.0.1:8790/webjs/
```

Nothing is uploaded. The page fetches `../assets/tile_base.stl`, pulls
Manifold's WASM from a CDN, and does everything else locally.

## Does it produce the same tiles?

Measured against the Python on `examples/fuchsia.svg`, one tile, margin 2.5:

| | Python | Browser |
|---|---|---|
| body volume | 1849.1714 mm³ | 1849.1506 mm³ (0.0011% off) |
| ink volume | 118.4562 mm³ | 118.4771 mm³ (0.0176% off) |
| both watertight | yes | yes |
| body + ink vs base | +0.000018 mm³ | **+0.000018 mm³** |
| 3MF entries / objects / extruders | 4 / 3 / 1,2 | 4 / 3 / 1,2 |

The reconstruction figure is the one that matters, and it is identical to the
Python's to every digit `selftest.py` prints. The volume deltas are curve
flattening — the browser samples paths through `getPointAtLength`, svgelements
computes them analytically — and 0.02% is orders of magnitude below what a
0.4 mm nozzle resolves.

A 3 × 7 panel produces 21 objects with no missing cells, and the 3MF passes a
CRC check as a zip.

## Why it is so little code

Two things carry it:

- **Manifold ships the same engine as WASM.** `manifold3d` in Python and
  `manifold-3d` on npm are the same C++ project, so the mesh booleans are not
  a reimplementation, they are the same code.
- **`CrossSection` is Clipper2 with fill rules built in.** That replaces both
  shapely *and* tilegen.py's hand-rolled nonzero winding-number partition —
  `new CrossSection(contours, 'NonZero')` is the whole of it.

The browser itself replaces svgelements: every shape is an
`SVGGeometryElement`, so `getPointAtLength` flattens béziers and arcs exactly
as the renderer would, `getComputedStyle` resolves fill through CSS and
inheritance, and `getCTM` bakes in nested transforms.

## What had to be written by hand

- **Subpath splitting** (`svgload.js`). The DOM will not hand back individual
  subpaths, and the fill rule is defined over them — an `o` whose counter is a
  second subpath must arrive as two rings. Hence a path tokenizer.
- **STL welding** (`stl.js`). An STL is a triangle soup; Manifold's
  constructor throws on anything that is not an oriented 2-manifold.
- **Zip** (`threemf.js`). `CompressionStream('deflate-raw')` is exactly what a
  zip entry wants, so this is a CRC table and a few headers, no library.

## Warnings

The thin-feature and crop warnings are ported. They tell you a logo will not
survive the nozzle before you print it, which is the whole point of them.

The reported PERCENTAGES differ from the CLI's by a few points and are not
tuned to match. shapely offsets through GEOS, this goes through Clipper2, and
the miter limit dominates the difference: on the example logo at an
exaggerated 2 mm nozzle, ink loss reads 25.8% at miter limit 2 and 13.1% at
100, against the CLI's 17%. Fitting a limit to match on one input would be
wrong on the next. Both use the same parameter shapely defaults to (5.0), and
at realistic nozzle sizes they agree on the thing that matters -- whether to
warn at all. On a 3x7 panel at 0.4 mm both emit exactly one warning.

## Not ported

- `--rotate`, `--bleed`, `--scale`, `--invert`, `--plate-origin`.
- `--rebuild-base`, which needs OpenSCAD and so is inherently a CLI job.

## Tests

`python3 webjs/tests/run.py` runs 48 differential checks in headless Chrome
against numbers derived from `tilegen.py`. See `webjs/tests/README.md`.

It earned its place on the first run by catching a real bug: `resolveOverlaps`
had never been ported, so quantized raster regions overlapped on their shared
boundary and were extruded twice.
