# tilegen

[![tests](https://github.com/curtisgalloway/framework-tile-maker/actions/workflows/tests.yml/badge.svg)](https://github.com/curtisgalloway/framework-tile-maker/actions/workflows/tests.yml)

Turn any SVG or image into Framework Desktop front-panel tiles, as multi-color
parts ready to slice. One tile or all 21, with artwork split across the grid.

---

## Use it now

### → **[curtisgalloway.github.io/framework-tile-maker](https://curtisgalloway.github.io/framework-tile-maker/)**

Drop in an SVG or a photo, press **Generate**, download the `.3mf`, open it in
Bambu Studio. Nothing to install, nothing to clone, and nothing is uploaded —
the whole pipeline runs in your browser tab.

[Help and options](https://curtisgalloway.github.io/framework-tile-maker/webjs/help.html)
covers every control.

---

## Running it yourself

Only needed if you want to modify it or work offline:

```bash
git clone --recurse-submodules https://github.com/curtisgalloway/framework-tile-maker.git
cd framework-tile-maker
python3 -m http.server 8790        # any static file server will do
```

Then open <http://127.0.0.1:8790/webjs/>. Cloned without
`--recurse-submodules`? Run `git submodule update --init`.

## What comes out

| File | What it is |
|---|---|
| `NAME.3mf` | Both parts as one object, filaments already assigned. **Use this.** |
| `NAME_body.stl` | Tile with the artwork pocketed out |
| `NAME_ink_1_#RRGGBB.stl` | The insert that fills the pocket exactly |
| `NAME_preview.png` | What the panel surface will look like, before you print |

Body and inserts share the exact same boundary surface — no gap, no overlap.
The two reconstruct the original tile to within 2 × 10⁻⁵ mm³.

---

## Recipes

| Want | Do |
|---|---|
| Logo on one tile | leave the grid at 1 × 1, margin 2.5 |
| One image across the whole panel | click **use it** (3 × 7, margin 0, fit cover) |
| A 2 × 2 block | columns 2, rows 2, fit contain |
| Photo in four colours | pick a JPG, colors 4, fit cover |
| Deeper inlay for white-on-black | depth 1.0 |
| Every tile, even blank ones | leave **blank tile for every empty cell** ticked |

## Options worth knowing

- `--depth 0.6` — inlay depth. 0.6 mm is 3 layers at 0.2 mm, opaque with most
  filaments. Past **1.6 mm** the pocket breaks into the retention hook cut-outs;
  the tool warns you.
- `--background auto` — for images, the color around the border becomes the
  bare tile body instead of a printed color. Saves a filament and all its
  purge. `--background none` to print it anyway, or `--background '#ffffff'`
  to name it.
- `--colors N` — how many colors to quantize an image to. Region 1 becomes
  filament 2, region 2 becomes filament 3, and so on.
- `--fit contain | cover | stretch` — `contain` fits the whole artwork inside
  the grid, `cover` fills the grid and crops, `stretch` distorts to fit.
- `--margin` — keep-out from each tile edge. Use `0` for multi-tile artwork so
  it runs across the seams; use `2` or `3` for a single centered logo.
- `--nozzle 0.4` — drives the thin-feature warnings.
- `--base blank|horizontal|cross|grid|frame` — which tile base to carve into.
  `blank` is the solid face and the default. The others have **open faces**:
  artwork over an opening has no material to carve, so it does not print
  there, and what remains is split into one fragment per opening (28 of them
  for the example logo on `cross`). That is the effect you are asking for, but
  fragments narrower than the mesh tolerance can come out non-watertight —
  slice-check before a long print.
- `--mirror` — only if you print the tile face-up. See *Orientation* below.
- `--embed-filaments` — write the colors into the 3MF, so the slicer opens
  with them assigned instead of bare slot numbers. Ink colors come from the
  artwork. Pair with `--body-color '#2f2f31'` to name the spool you'll load
  for the tile body (filament 1), and `--filament-type PETG` to record the
  material. Off by default: it adds a `project_settings.config`, which is
  project-scoped, so the default output stays exactly as it was.

---

## Printing on the H2D

- **Print face down.** The model already sits that way: the decorated face is
  at z=0, the retention hooks rise in +z. The artwork lands in the first few
  layers against the build plate, which gives the crispest color boundary and
  a smooth finish.
- **Two colors, two nozzles.** Assign body and ink to separate nozzles and the
  H2D swaps without a purge tower. Three or more colors pulls from an AMS and
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
- **One color, one filament, across every tile.** A tile only carries the
  colors whose artwork reaches it, so the filament slot has to be assigned
  from the full color list before tiles are cut, not from what each tile
  happens to contain. Numbering per tile makes three different colors all come
  out as filament 2 and a three-color panel slices as one color, silently.
  the test suite prints three colored bands across a 3 × 1 grid and asserts
  distinct colors get distinct filaments.
- **Fill rule.** SVG `fill-rule="nonzero"` is honored by computing winding
  numbers, not approximated with even-odd. Get this wrong and counters — the
  inside of an "o", the eye of a spiral — fill in solid. Checked against a
  reference render at IoU 0.996.
- **The artwork canvas is not `cols x pitch`.** Outer tiles contribute only
  their face, and every tile loses `margin` at each edge, so the canvas is
  `(cols-1)*pitch + face - 2*margin`. Sizing to `cols*pitch` overscales by
  `(pitch - face) + 2*margin` and silently crops the artwork — at `--margin 2.5`
  on a single tile that is 18%. The tool reports any real crop.

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

## Licensing

Two licenses apply here, to different things. The short version: **the code is
Apache 2.0, the tile geometry is CC BY-SA 4.0, and anything you print carries
the CC BY-SA obligations.**

| | License | Why |
|---|---|---|
| `webjs/`, `bases/render.sh` | Apache 2.0 | Original work, © 2026 Curtis Galloway |
| `vendor/desktoptiles/` | CC BY-SA 4.0 | Marcin Raczkowski's repo, vendored as a submodule. Not ours, and not copied into this one |
| `assets/tile_base.stl` | CC BY-SA 4.0 | A render *of* his `tile_base.scad`, so it inherits his license |
| `examples/*.stl`, `examples/*.3mf` | CC BY-SA 4.0 | Same — they contain his tile body |
| **Tiles you generate** | **CC BY-SA 4.0** | Every tile embeds his frame, hooks and constraints |

### What that means in practice

**Using the tool, keeping the tiles to yourself:** nothing to do.

**Publishing or selling tiles you generated** — on Printables, MakerWorld, Etsy,
anywhere: they are derivative works of `tile_base.scad`, so CC BY-SA 4.0
requires you to

1. credit **Marcin Raczkowski (Marmot.Tech)** and link
   <https://github.com/jermicide/desktoptiles>,
2. license the tiles themselves under CC BY-SA 4.0, and
3. say the work was modified.

The [help page](https://curtisgalloway.github.io/framework-tile-maker/webjs/help.html#credits) has text you can paste.

**Reusing tilegen's code** in your own project: Apache 2.0, so keep the notice
and go ahead. Note that Apache 2.0 covers only the code — the moment your
project renders a tile, the output is CC BY-SA again.

**Why not one license for everything?** Apache 2.0 and CC BY-SA 4.0 are not
compatible in either direction, so they cannot be merged — the tile base could
not be relicensed Apache even in principle, since it isn't ours to relicense.
Keeping them separate is what makes the boundary honest: the submodule means
his file is never copied here, and the table above says exactly which artifacts
inherit which terms. `NOTICE.md` records the same thing in one place.

---

## How it is tested

`webjs/tests/run.py` runs 48 checks in headless Chrome against the real
modules — no mocks, no reimplementation. It needs Python only as a process
launcher; there are no third-party packages at all.

The strongest checks are invariants rather than comparisons: body and ink must
reconstruct the base tile to within 2 × 10⁻⁵ mm³, every mesh must be
watertight, each colour must hold one filament slot across every tile, and the
thin-feature warnings must fire on artwork below the nozzle and stay quiet
above it.

The recorded per-tile volumes in `webjs/tests/expected.json` were derived from
a Python implementation that used to live in this repo, and are kept as a
frozen regression snapshot. See `webjs/tests/README.md`.

## The preview shows the real surface

`NAME_preview.png` is drawn from the actual base mesh, not a square: the face
is sliced just above z=0, so the openings in `grid`, `cross`, `horizontal` and
`frame` appear as openings, and artwork is clipped to the material that is
really there. On an open-faced base you can see at a glance which parts of
your artwork survive and which fall into a gap and never print.

## Tile bases

| `--base` | Face | Volume |
|---|---|---|
| `blank` | solid | 1967.63 mm³ |
| `grid` | crossed stripes | 1688.94 mm³ |
| `cross` | diagonal stripes | 1451.97 mm³ |
| `horizontal` | horizontal stripes | 1438.11 mm³ |
| `frame` | none — border only | 1028.20 mm³ |

All five are watertight closed solids, and the test suite checks that, their
dimensions, and that body + ink still reconstructs whichever base was chosen.

They are built by `bases/tilegen_bases.scad`, which `include`s the vendored
`tile_base.scad` unmodified and composes its modules — the extension point
that file's own usage comment documents. Two things made a wrapper necessary
rather than just passing `tile_type`:

- **`tile_base.scad`'s own `crosshatch_fill` clips its stripes to exactly
  `inner_size`**, the same square the frame's inner edge sits on. At angle 0
  the stripes meet that edge squarely and the union is clean; at any other
  angle the slanted ends graze the frame corners with zero-area contact and
  OpenSCAD emits a non-manifold mesh — under *both* backends, at every hatch
  angle and thickness tried. The wrapper runs the stripes past `inner_size` so
  they meet the frame volumetrically.
- **The hook cut-outs are themselves at 45° + 90n.** Stripes at 45° are
  coplanar with the faces being subtracted, which is non-manifold again.
  Measured watertight at 30° and 60°, non-manifold at 15°, 22.5°, 45° and
  67.5°, so the stripe angle defaults to 30°.

---

## Regenerating the tile bases

The five base STLs in `assets/` are committed and the app loads them directly,
so you should not need this. It exists so the bases stay derivable from Marcin
Raczkowski's CC BY-SA source rather than being opaque binaries.

```bash
git submodule update --init      # needs the vendored .scad
./bases/render.sh                # needs OpenSCAD on PATH
```

`bases/render.sh` documents the two non-obvious flags: OpenSCAD's default
Manifold backend exports these bases as meshes that do not close into solids,
so CGAL is requested explicitly; and the stripe angle avoids 45°, where the
stripes go coplanar with the hook cut-outs.