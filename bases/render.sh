#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Curtis Galloway
# SPDX-License-Identifier: Apache-2.0
#
# Render the five tile bases from tilegen_bases.scad into ../assets/.
#
#   ./bases/render.sh            # all five
#   ./bases/render.sh grid       # just one
#
# Needs OpenSCAD on PATH and the vendored submodule checked out
# (git submodule update --init).
#
# You should not need this: the rendered STLs are committed, and the browser
# app loads them directly. It exists so the tile bases remain derivable from
# Marcin Raczkowski's CC BY-SA source rather than being opaque binaries.
#
# Two flags here are not obvious and were expensive to establish:
#
#   --backend=CGAL   OpenSCAD now defaults to the Manifold backend, which
#                    exports these bases as facets that do not close into a
#                    solid -- 472 instead of 332 for 'blank', not watertight,
#                    and the boolean stage then fails with "Not all meshes are
#                    volumes!". CGAL renders the same solid (volumes agree to
#                    ~1e-3 mm3) as a clean closed mesh.
#
#   tg_angle=30      Set inside tilegen_bases.scad, not here, but worth
#                    knowing: the hook cut-outs sit at 45 + 90n degrees, so
#                    45-degree stripes end up coplanar with the faces being
#                    subtracted and the result is non-manifold. Measured
#                    watertight at 30 and 60; non-manifold at 15, 22.5, 45
#                    and 67.5.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scad="$here/tilegen_bases.scad"
out="$here/../assets"

command -v openscad >/dev/null || {
  echo "openscad not found on PATH" >&2; exit 1; }
[ -f "$here/../vendor/desktoptiles/tile_base.scad" ] || {
  echo "submodule missing: git submodule update --init" >&2; exit 1; }

render() {
  case "$1" in
    blank) file="tile_base.stl" ;;
    *)     file="tile_base_$1.stl" ;;
  esac
  echo "  $1 -> assets/$file"
  openscad -o "$out/$file" --backend=CGAL \
      -D "tg_base=\"$1\"" -D '$colorize_elements=false' "$scad" 2>/dev/null
}

for b in "${@:-blank frame horizontal cross grid}"; do
  render "$b"
done

echo
echo "Verify every base is a closed solid before committing -- a non-watertight"
echo "base fails the boolean stage at run time, not at render time:"
echo "  python3 -c \"import trimesh,glob;[print(p, trimesh.load(p).is_watertight) for p in sorted(glob.glob('assets/tile_base*.stl'))]\""
