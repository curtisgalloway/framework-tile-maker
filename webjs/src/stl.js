// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// STL in and out. The tile base ships as an ASCII STL, but a user-supplied
// one could be either, so both are read.

/** Detect and parse an STL from an ArrayBuffer into {positions, indices}. */
export function parseSTL(buf) {
  const bytes = new Uint8Array(buf);
  // A binary STL is exactly 84 + 50*n bytes. Checking that is far more
  // reliable than sniffing for a leading "solid", which ASCII and some
  // binary writers both emit.
  if (bytes.length >= 84) {
    const n = new DataView(buf).getUint32(80, true);
    if (84 + n * 50 === bytes.length) return parseBinary(buf, n);
  }
  return parseASCII(new TextDecoder().decode(bytes));
}

function parseBinary(buf, n) {
  const dv = new DataView(buf);
  const positions = new Float32Array(n * 9);
  let o = 84;
  for (let t = 0; t < n; t++) {
    o += 12;                                   // skip the face normal
    for (let v = 0; v < 9; v++) {
      positions[t * 9 + v] = dv.getFloat32(o, true);
      o += 4;
    }
    o += 2;                                    // attribute byte count
  }
  return weld(positions);
}

function parseASCII(text) {
  const nums = [];
  // \b so `subvertex` does not match, and /i because the format does not
  // mandate lowercase keywords.
  const re = /\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const x = +m[1], y = +m[2], z = +m[3];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`STL: non-numeric vertex "${m[1]} ${m[2]} ${m[3]}"`);
    }
    nums.push(x, y, z);
  }
  // Returning an empty mesh here is worse than failing: it is indistinguishable
  // from a valid empty model, and the caller hands it to Manifold, which fails
  // later with something that does not mention the file.
  if (!nums.length) {
    throw new Error('STL: no vertices found (not a readable ASCII or binary STL)');
  }
  if (nums.length % 9 !== 0) {
    throw new Error(`STL: ${nums.length / 3} vertices is not a whole number ` +
                    `of triangles (file truncated mid-facet?)`);
  }
  return weld(new Float32Array(nums));
}

/**
 * Merge identical vertices into an indexed mesh.
 *
 * Manifold's constructor throws unless the input is an oriented 2-manifold,
 * and an STL is a triangle soup with every vertex repeated per face, so
 * welding is required, not an optimization.
 */
function weld(positions) {
  // Snap to a grid, but ALSO look in the neighbouring cells before deciding a
  // vertex is new. Hashing a bare quantized key is not enough: two writes of
  // the same physical corner can differ in the last float32 bit, and if that
  // difference straddles a cell boundary (2.500005 -> "2.50001" against
  // 2.500004 -> "2.50000") the corner does not weld and the mesh keeps a crack
  // -- precisely the non-manifold input welding exists to prevent. The float32
  // ulp near tile coordinates is ~1e-6 against this 1e-5 grid, so boundary
  // straddles are rare but not rare enough over thousands of vertices.
  const GRID = 1e5;                      // 5 decimal places
  const map = new Map();
  const verts = [];
  const indices = new Uint32Array(positions.length / 3);

  for (let i = 0; i < positions.length; i += 3) {
    const gx = Math.round(positions[i] * GRID);
    const gy = Math.round(positions[i + 1] * GRID);
    const gz = Math.round(positions[i + 2] * GRID);

    let id;
    outer:
    for (let dx = -1; dx <= 1 && id === undefined; dx++) {
      for (let dy = -1; dy <= 1 && id === undefined; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const hit = map.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (hit !== undefined) { id = hit; break outer; }
        }
      }
    }
    if (id === undefined) {
      id = verts.length / 3;
      map.set(`${gx},${gy},${gz}`, id);
      verts.push(positions[i], positions[i + 1], positions[i + 2]);
    }
    indices[i / 3] = id;
  }
  return {positions: new Float32Array(verts), indices};
}


/** Manifold -> binary STL blob. */
export function exportSTL(man) {
  const mesh = man.getMesh();
  const nt = mesh.triVerts.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(
      new TextEncoder().encode('tilegen'.padEnd(80, ' ')).slice(0, 80));
  dv.setUint32(80, nt, true);
  const P = mesh.vertProperties, np = mesh.numProp;
  let o = 84;
  for (let t = 0; t < nt; t++) {
    o += 12;                                   // zero normal; slicers recompute
    for (let c = 0; c < 3; c++) {
      const v = mesh.triVerts[t * 3 + c] * np;
      dv.setFloat32(o, P[v], true);
      dv.setFloat32(o + 4, P[v + 1], true);
      dv.setFloat32(o + 8, P[v + 2], true);
      o += 12;
    }
    o += 2;
  }
  return new Blob([buf], {type: 'model/stl'});
}
