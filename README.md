# tilegen

Turn any SVG or image into Framework Desktop front-panel tiles, as multi-color
parts ready to slice. One tile or all 21, with artwork split across the grid.

---

## Do this first

**Open it in a browser. There is nothing to install.**

```bash
git clone --recurse-submodules <this repo>
cd tilegen
python3 -m http.server 8790        # any static file server will do
```

Then open <http://127.0.0.1:8790/webjs/>, drop in an SVG or a photo, and hit
**Generate**. You get the panel preview and a `.3mf` to open in Bambu Studio.

Nothing is uploaded and nothing is installed: the page fetches the tile base
from `assets/`, pulls Manifold's geometry kernel as WebAssembly, and does the
rest in the tab. A single tile takes about two seconds.

> **Prefer the command line?** `tilegen.py` does everything the page does and a
> few things it does not. See [Command line](#command-line) below.

---

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

```bash
# Logo on one tile, 2.5 mm clear of the edges
python3 tilegen.py logo.svg --margin 2.5

# One image across the whole front panel (3 wide x 7 tall)
python3 tilegen.py artwork.png --grid 3x7 --fit cover

# A 2x2 block in the corner of the panel
python3 tilegen.py logo.svg --grid 2x2 --fit contain

# Photo in four colors
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

## Command line

`tilegen.py` is the original implementation and remains the reference: it is
what `selftest.py`'s 54 checks exercise, and what the browser version is
measured against.

```bash
pip install -r requirements.txt
python3 tilegen.py logo.svg --margin 2.5
```

It has a few things the page does not: `--rotate`, `--bleed`, `--scale`,
`--invert`, thin-feature and crop warnings, `--plate-origin`, and
`--rebuild-base`.

There is also `webui.py`, a local page that shells out to the CLI. It predates
the browser version and exists for driving the CLI's extra flags through a
form; for ordinary use prefer `/webjs/`, which needs no Python at all.

```bash
pip install -r requirements.txt -r requirements-web.txt
python3 webui.py        # http://127.0.0.1:8770
```

- **`--port N`** if 8770 is taken. It checks the port first and tells you what
  to do rather than binding somewhere you are not expecting.
- **Loopback only by default.** There is no auth, no upload limit and no job
  queue — it is a convenience wrapper for one person on one machine, not a
  service. `--host` will bind wider, and warns you when you do.
- The **use it** link next to the grid fills in the full 3 × 7 panel with the
  settings that suit it (margin 0, fit cover) in one click.
- **Tile base** picks the same five bases as `--base`, and warns when you
  choose an open-faced one.
- **set filament colors in the 3MF** reveals a filament-type list and a
  second checkbox, **also set the body color**, matching `--embed-filaments`
  and `--body-color`. Leave that one off and slot 1 stays unset — tilegen
  doesn't guess what spool you loaded.
- **Blank tiles are kept by default here**, unlike the CLI. Ask for 3 × 7 and
  you get 21 tiles, including the cells the artwork never reaches — a panel
  needs all of them to be physically complete. Untick the box for the CLI's
  behavior of emitting only the tiles that carry artwork. Either way the page
  reports the count, and says so in amber when cells were left out.

---

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
  `selftest.py` section 7 prints three colored bands across a 3 × 1 grid and
  asserts distinct colors get distinct filaments.
- **Fill rule.** SVG `fill-rule="nonzero"` is honored by computing winding
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

## Licensing

Two licenses apply here, to different things. The short version: **the code is
Apache 2.0, the tile geometry is CC BY-SA 4.0, and anything you print carries
the CC BY-SA obligations.**

| | License | Why |
|---|---|---|
| `tilegen.py`, `selftest.py`, `webui.py`, `web/` | Apache 2.0 | Original work, © 2026 Curtis Galloway |
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

Run `python3 tilegen.py --credits` for text you can paste.

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

## How the browser version compares

Both implementations share the geometry kernel: `manifold3d` in Python and
`manifold-3d` on npm are the same C++ project, so the mesh booleans are
literally the same code. Measured on the same inputs:

| | Python | Browser |
|---|---|---|
| `fuchsia.svg`, 1 tile, body | 1849.1714 mm³ | 1849.1506 mm³ |
| body + ink vs base | +0.000018 mm³ | +0.000018 mm³ |
| `--base grid`, body | 1595.8 mm³ | 1595.8 mm³ |
| 3 × 7 panel, all 20 carved tiles | — | match to 0.1 mm³ |
| a photo, body | 1958.5 mm³ | 1953.1 mm³ (0.28% apart) |
| a photo, wall clock | 2.3 s | 0.5 s |
| thin-feature warnings | yes | yes (percentages differ, see below) |

The thin-feature warnings fire in both, on the same tiles, but the reported
percentages differ by a few points: shapely offsets through GEOS and the
browser through Clipper2. `webjs/README.md` has the measurements and why they
are not tuned to match.

SVG agrees to five decimal places, because both sides do the same arithmetic.
Photos differ by a fraction of a percent because the tracers differ — OpenCV's
`findContours` against marching squares — which is two tools disagreeing about
where a soft edge sits, not one being wrong, and it is far below what a 0.4 mm
nozzle resolves.

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

All five are watertight closed solids, and `selftest.py` section 8 checks
that, their dimensions, and that body + ink still reconstructs whichever base
was chosen.

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

## Regenerating the tile base

`assets/tile_base.stl` is a cached render of
`vendor/desktoptiles/tile_base.scad`. To rebuild it after changing tile
parameters, with the submodule checked out and OpenSCAD on PATH:

```bash
python3 tilegen.py logo.svg --rebuild-base
```

Neither OpenSCAD nor the submodule is needed otherwise — the cached mesh ships
with the tool.

`tilegen` asks OpenSCAD for the **CGAL** backend explicitly. OpenSCAD now
defaults to the newer Manifold backend, which exports this model as 472 facets
that do not close into a solid; the boolean stage then fails with *"Not all
meshes are volumes!"*. CGAL produces the same solid — volumes agree to five
decimal places — as a clean watertight 332-facet mesh. If a rebuild ever does
come out non-watertight, `tilegen` says so and stops rather than emitting a
broken tile.

To move to a newer upstream tile base:

```bash
git -C vendor/desktoptiles pull origin main
python3 tilegen.py logo.svg --rebuild-base
git add vendor/desktoptiles assets/tile_base.stl
```
