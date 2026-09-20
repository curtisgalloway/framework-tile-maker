# Attribution

## tilegen itself

Copyright 2026 Curtis Galloway
Licensed under the Apache License, Version 2.0 -- see LICENSE.
This covers `tilegen.py`, `selftest.py`, `webui.py`, `web/` and
`bases/tilegen_bases.scad` only. Everything below is not ours
and carries different terms; README.md -> "Licensing" has the full breakdown.

## tile_base.scad (vendor/desktoptiles)

Copyright 2025 Marcin Raczkowski (Marmot.Tech)
Licensed under Creative Commons Attribution-ShareAlike 4.0 International
https://creativecommons.org/licenses/by-sa/4.0/
Source: https://github.com/jermicide/desktoptiles

Not copied into this repository. It is vendored **unmodified** as a git
submodule at `vendor/desktoptiles`, pinned to an upstream commit; fetch it
with `git submodule update --init`. All tile body geometry -- frame,
retention hooks, constraints, raised edges, and the hook cut-outs that coerce
the slicer into building proper walls -- is his work. tilegen only adds
artwork to that base.

## Derivative works (CC BY-SA 4.0, not Apache 2.0)

Anything containing the tile body is a derivative of tile_base.scad and so is
CC BY-SA 4.0, regardless of this project's own license. That includes:

  - assets/tile_base*.stl     (cached renders built on his .scad)
  - examples/*.stl, *.3mf     (they contain his tile body)
  - every tile this tool generates

If you publish or distribute any of those, credit Marcin Raczkowski
(Marmot.Tech), state that the work was modified, and license alike.

## Framework Computer

Tile geometry follows the published specification in
https://github.com/FrameworkComputer/Framework-Desktop -> Tiles/
  - FRAMEWORK_DESKTOP_BLANK_TILE_V0.pdf  (tile 28.45 +/-0.05 mm)
  - fw_desktop_front_cover.stl           (panel pitch 28.60 mm, measured)
