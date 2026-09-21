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
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    nums.push(+m[1], +m[2], +m[3]);
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
  const map = new Map();
  const verts = [];
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < positions.length; i += 3) {
    // Quantize before hashing: STL stores float32 text, so the same corner can
    // differ in the last bit between faces and never match as an exact key.
    const key = `${positions[i].toFixed(5)},${positions[i + 1].toFixed(5)},` +
                `${positions[i + 2].toFixed(5)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      map.set(key, id);
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
