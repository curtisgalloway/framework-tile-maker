<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# Browser tests

48 regression checks. The browser modules run for real in headless Chrome.

```bash
python3 webjs/tests/run.py              # non-zero exit on failure
python3 webjs/tests/run.py --headed     # watch it in a visible browser
```

stdlib only — no pip install, no npm.

Open `/webjs/tests/` in any browser to run the same suite by hand.

## Why a real browser

The SVG loader uses the browser's own SVG engine on purpose — `getPointAtLength`
flattens curves exactly as the renderer would — and the raster path uses canvas.
jsdom implements neither, so headless Chrome is the only honest harness. The
runner starts a static server, launches Chrome, and the page POSTs its results
back; stdlib only, no npm.

## expected.json is a frozen snapshot

These were derived from the Python reference implementation that used to live
in this repo, and were correct against it when recorded. That implementation
has been removed, so they are now **golden values**: a failure means the
browser's behaviour changed, which is what a regression suite is for — but no
longer that it disagrees with an independent implementation.

Several checks never needed the reference and are the stronger ones: body+ink
reconstructing the base to 0.00002 mm³, watertightness, distinct filament slots
per colour, and whether the thin-feature warnings fire. Those are invariants,
and they would catch a real geometry regression with every recorded number
deleted. It is the per-tile volume comparisons that lost their independence.

## Tolerances, and why they differ

| | Tolerance | Why |
|---|---|---|
| single tile, SVG | 0.05 mm³ | same kernel, same contours; agrees to ~0.02 |
| reconstruction | 0.001 mm³ | exact: a boolean partition cannot drift |
| 3×7 panel | 0.15 mm³ | flattening error scales with artwork size |
| raster, smooth | 1% | recorded against a different tracer; measures 0.03% |
| raster, noise | 8% | see below |

The noise fixture is 160 px of high-frequency speckle. Every blob is a few
pixels across, so marching squares placing its isoline on the half-pixel
boundary shifts a large perimeter relative to a small area, and the two tracers
land ~4.6% apart. That is inherent to the fixture, not a defect — which the
smooth fixture proves by agreeing to 0.03% on the same code path. So the noise
fixture asserts *survival and self-consistency* rather than agreement.

The exact assertion there — body + ink reconstructing the base — is what caught
the missing `resolveOverlaps`: quantized regions are disjoint by pixel, but
their contours are traced independently, so neighbours both claimed the
boundary strip and the overlap was extruded twice (+2.22 mm³). Verified to
still bite: removing `resolveOverlaps` fails that check and only that check.
