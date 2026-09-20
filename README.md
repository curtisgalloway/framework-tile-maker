# tilegen

Turn any SVG or image into Framework Desktop front-panel tiles, as multi-colour
parts ready to slice. One tile or all 21, with artwork split across the grid.

---

## Do this first

```bash
git submodule update --init      # fetches the tile base from upstream
pip install numpy trimesh manifold3d shapely svgelements opencv-python-headless pillow matplotlib
python3 tilegen.py fuchsia.svg --margin 2.5
```

Cloning fresh? Use `git clone --recurse-submodules` and skip the first line.

That writes `out/fuchsia.3mf`. Open it in Bambu Studio, set filament 1 to the
tile colour and filament 2 to the logo colour, slice. Nothing else to configure.

Takes about 5 seconds. A full 21-tile panel takes about 4 seconds.

---

## What comes out

| File | What it is |
|---|---|
| `NAME.3mf` | Both parts as one object, filaments already assigned. **Use this.** |
| `NAME_body.stl` | Tile with the artwork pocketed out |
| `NAME_ink_1_#RRGGBB.stl` | The insert that fills the pocket exactly |
| `NAME_preview.png` | What the panel will look like, before you print |

Body and inserts share the exact same boundary surface — no gap, no overlap.
The two reconstruct the original tile to within 2 × 10⁻⁵ mm³.

---

## Recipes

```bash
# Logo on one tile, 2.5 mm clear of the edges
python3 tilegen.py logo.svg --margin 2.5

# One image across the whole front panel (3 wide x 7 tall)
python3 tilegen.py artwork.png --grid 3x7 --fit cover

# A 2x2 block in the corner of the panel
python3 tilegen.py logo.svg --grid 2x2 --fit contain

# Photo in four colours
python3 tilegen.py photo.jpg --grid 3x7 --colors 4 --fit cover

# Deeper inlay for white-on-black, where 3 layers still shows through
python3 tilegen.py logo.svg --depth 1.0

# Keep all 21 tiles even where the artwork is blank
python3 tilegen.py artwork.png --grid 3x7 --fit cover --keep-empty
```

`--credits` prints attribution. `--help` lists everything.

```bash
python3 selftest.py     # 20 regression checks, ~20 s
```

---

## Options worth knowing

- `--depth 0.6` — inlay depth. 0.6 mm is 3 layers at 0.2 mm, opaque with most
  filaments. Past **1.6 mm** the pocket breaks into the retention hook cut-outs;
  the tool warns you.
- `--background auto` — for images, the colour around the border becomes the
  bare tile body instead of a printed colour. Saves a filament and all its
  purge. `--background none` to print it anyway, or `--background '#ffffff'`
  to name it.
- `--colors N` — how many colours to quantise an image to. Region 1 becomes
  filament 2, region 2 becomes filament 3, and so on.
- `--fit contain | cover | stretch` — `contain` fits the whole artwork inside
  the grid, `cover` fills the grid and crops, `stretch` distorts to fit.
- `--margin` — keep-out from each tile edge. Use `0` for multi-tile artwork so
  it runs across the seams; use `2` or `3` for a single centred logo.
- `--nozzle 0.4` — drives the thin-feature warnings.
- `--mirror` — only if you print the tile face-up. See *Orientation* below.

---

## Printing on the H2D

- **Print face down.** The model already sits that way: the decorated face is
  at z=0, the retention hooks rise in +z. The artwork lands in the first few
  layers against the build plate, which gives the crispest colour boundary and
  a smooth finish.
- **Two colours, two nozzles.** Assign body and ink to separate nozzles and the
  H2D swaps without a purge tower. Three or more colours pulls from an AMS and
  purges normally.
- **Body is filament 1.** Inks are 2, 3, 4… in the order printed in the console.
- The tile is 28.5 mm square; 21 of them fit a 256 mm plate in one go.

---

## Why these numbers

- **Pitch 28.60 mm.** Measured from Framework's own released CAD
  (`Tiles/fw_desktop_front_cover.stl`): the tile openings step by exactly 28.60
  in both axes. Several community projects use 28.5, which drifts ~0.6 mm over
  seven rows. Override with `--pitch`.
- **The whole tile face is visible.** At the depth where the tile face sits, the
  cover has no material anywhere across the grid — the 20.9 mm openings deeper
  in are for the retention hooks, not a window over the face. Adjacent tiles
  meet with a ~0.15 mm seam, so artwork runs across tile boundaries nearly
  unbroken.
- **Orientation.** The decorated face is seen from −z, where screen-right is −X
  and screen-down is −Y. That makes the image-to-tile mapping a 180° rotation,
  not a mirror, so artwork is never reversed. Verified by sectioning the
  finished mesh and rendering it from outside.
- **Fill rule.** SVG `fill-rule="nonzero"` is honoured by computing winding
  numbers, not approximated with even-odd. Get this wrong and counters — the
  inside of an "o", the eye of a spiral — fill in solid. Checked against a
  reference render at IoU 0.996.
- **The artwork canvas is not `cols x pitch`.** Outer tiles contribute only
  their face, and every tile loses `margin` at each edge, so the canvas is
  `(cols-1)*pitch + face - 2*margin`. Sizing to `cols*pitch` overscales by
  `(pitch - face) + 2*margin` and silently crops the artwork — at `--margin 2.5`
  on a single tile that is 18%. `selftest.py` checks the aspect ratio survives,
  and the tool now reports any real crop.

---

## Credits

**`tile_base.scad` is the work of Marcin Raczkowski (Marmot.Tech)**, licensed
**CC BY-SA 4.0**, from <https://github.com/jermicide/desktoptiles>. No copy of
it lives in this repository — it is vendored unmodified as a git submodule at
`vendor/desktoptiles`, pinned to an upstream commit. All tile body geometry —
the frame, the retention hooks, the constraints, the raised edges, the hook
cut-outs that make the slicer build proper walls — is his. `tilegen` only adds
artwork to it.

His tile follows Framework's published spec,
[`FRAMEWORK_DESKTOP_BLANK_TILE_V0.pdf`](https://github.com/FrameworkComputer/Framework-Desktop/blob/main/Tiles/),
and the panel pitch used here was measured from Framework's
`Tiles/fw_desktop_front_cover.stl` in the same repository.

**Because `tile_base.scad` is CC BY-SA 4.0, tiles produced by this tool are
derivative works.** If you publish or share them, credit Marmot.Tech and
license alike.

---

## Regenerating the tile base

`assets/tile_base.stl` is a cached render of
`vendor/desktoptiles/tile_base.scad`. To rebuild it after changing tile
parameters, with the submodule checked out and OpenSCAD on PATH:

```bash
python3 tilegen.py logo.svg --rebuild-base
```

Neither OpenSCAD nor the submodule is needed otherwise — the cached mesh ships
with the tool.

To move to a newer upstream tile base:

```bash
git -C vendor/desktoptiles pull origin main
python3 tilegen.py logo.svg --rebuild-base
git add vendor/desktoptiles assets/tile_base.stl
```
