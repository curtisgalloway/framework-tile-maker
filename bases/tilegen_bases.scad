// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Extra tile bases for tilegen, built on Marcin Raczkowski's tile_base.scad
// (CC BY-SA 4.0, vendor/desktoptiles). That file is included unmodified and
// its modules are composed here, which is the extension point its own usage
// comment documents:
//
//     include <tile_base.scad>
//     tile_type = "none";
//     union() { full_frame(); my_design(); }
//
// Rendered tiles remain derivative works of his file -- see NOTICE.md.
//
// Why this file exists at all: tile_base.scad's own crosshatch_fill clips its
// stripes to exactly inner_size, the same square the frame's inner edge sits
// on. At angle 0 the stripes meet that edge squarely and the union is clean,
// but at any other angle the slanted ends graze the frame corners with
// zero-area contact and OpenSCAD emits a non-manifold mesh -- confirmed under
// both the CGAL and Manifold backends, at hatch angles 30/40/44/45/46 and
// thicknesses 0.8 through 2.0. The fix is not a parameter: it is to let the
// stripes run PAST inner_size so they meet the frame volumetrically.

include <../vendor/desktoptiles/tile_base.scad>

// Suppress the included file's own top-level output; we compose it ourselves.
tile_type = "none";

// How far the fill runs into the frame. Anything comfortably larger than a
// rounding error works: the overlap is buried inside frame material, so it
// changes nothing you can see or print.
tg_overlap = 0.5;

/* [tilegen] */
// Which base to render
tg_base = "blank"; // ["blank", "frame", "horizontal", "cross", "grid"]
// Stripe width [mm]
tg_thickness = 1.125;
// Stripe angle [deg]. NOT 45: the hook cut-outs are themselves at 45 + 90n
// degrees, so 45-degree stripes end up coplanar with the faces being
// subtracted and the result is non-manifold. Measured watertight at 30 and 60,
// non-manifold at 15, 22.5, 45 and 67.5.
tg_angle = 30;

module tg_stripes(angle, thickness) {
  span = inner_size + 2 * tg_overlap;
  n = ceil(inner_size / thickness / 2) + 2;
  linear_extrude(front_thickness) intersection() {
    square(span, center = true);
    union() for (i = [-n : n])
      rotate([0, 0, angle])
        translate([0, thickness * 2 * i])
          square([inner_size * 3, thickness], center = true);
  }
}

// The hook cut-outs must be taken out of the finished solid, not out of the
// fill alone: a stripe that now overlaps the frame would otherwise re-fill
// the cut-out the frame just made.
module tg_tile(fill_angle, thickness, striped = true, crossed = false) {
  difference() {
    union() {
      mounts();
      linear_extrude(frame_thickness)
        difference() {
          square(tile_size, center = true);
          square(inner_size, center = true);
        }
      if (striped) {
        tg_stripes(fill_angle, thickness);
        if (crossed) tg_stripes(-fill_angle, thickness);
      }
    }
    hook_cutout();
  }
}

if (tg_base == "blank") {
  blank_tile();
} else if (tg_base == "frame") {
  full_frame();
} else if (tg_base == "horizontal") {
  tg_tile(0, tg_thickness);
} else if (tg_base == "cross") {
  tg_tile(tg_angle, tg_thickness);
} else if (tg_base == "grid") {
  tg_tile(tg_angle, tg_thickness, striped = true, crossed = true);
}
