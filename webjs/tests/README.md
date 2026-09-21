<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# Browser tests

Differential tests: the browser modules run for real, and their numbers are
compared against `tilegen.py`, which stays the reference.

```bash
python3 webjs/tests/run.py              # 48 checks, non-zero exit on failure
python3 webjs/tests/run.py --headed     # watch it in a visible browser
python3 webjs/tests/run.py --update     # regenerate expected.json from tilegen.py
```

Open `/webjs/tests/` in any browser to run the same suite by hand.

## Why a real browser

The SVG loader uses the browser's own SVG engine on purpose — `getPointAtLength`
flattens curves exactly as the renderer would — and the raster path uses canvas.
jsdom implements neither, so headless Chrome is the only honest harness. The
runner starts a static server, launches Chrome, and the page POSTs its results
back; stdlib only, no npm.

## Why expectations are recorded, not recomputed

`expected.json` is generated from `tilegen.py` by `--update`. Recomputing on
every run would mean a failure could be the browser changing *or* a dependency
changing underneath the Python. Recording them makes a failure mean the browser
moved, and `--update` is there for when the Python legitimately does.

## Tolerances, and why they differ

| | Tolerance | Why |
|---|---|---|
| single tile, SVG | 0.05 mm³ | same kernel, same contours; agrees to ~0.02 |
| reconstruction | 0.001 mm³ | exact: a boolean partition cannot drift |
| 3×7 panel | 0.15 mm³ | flattening error scales with artwork size |
| raster, smooth | 1% | different tracers; measures 0.03% |
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
