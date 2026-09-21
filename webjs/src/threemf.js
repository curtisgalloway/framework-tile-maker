// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// Bambu-flavored 3MF writer, ported from tilegen.py's write_3mf.
//
// No zip library: CompressionStream('deflate-raw') is exactly the raw deflate
// a zip entry wants, so the whole archive is built from a CRC32 table and a
// few headers.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const out = new Response(
        new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(await out);
  } catch {
    return null;                                // fall back to stored
  }
}

/** Build a zip from [{name, data:Uint8Array}] and return a Blob. */
async function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    let body = await deflateRaw(e.data);
    let method = 8;
    if (!body || body.length >= e.data.length) {
      body = e.data;                            // stored beats a bigger deflate
      method = 0;
    }

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);                  // version needed
    lh.setUint16(6, 0, true);
    lh.setUint16(8, method, true);
    lh.setUint16(10, 0, true);                  // time
    lh.setUint16(12, 0x21, true);               // date: 1980-01-01, reproducible
    lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), nameBytes, body);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, 0, true);
    ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true);
    ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }

  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(eocd.buffer)],
                  {type: 'model/3mf'});
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

// XML 1.0 forbids the C0 control characters outright -- they are illegal even
// written as character references, so they have to be dropped rather than
// escaped. Tab, LF and CR are the three that are allowed. A filename may
// legally contain the others on POSIX, and it reaches here as the model title.
const esc = (s) => String(s)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[&<>"']/g, (c) => (
        {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[c]));

/**
 * objects: [{name, parts:[{name, mesh, extruder}], pos:[x, y]}]
 * filaments: optional [{color, type}] indexed from filament 1.
 */
export async function write3MF(objects, {title = 'tilegen', filaments = null} = {}) {
  const m = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<model unit="millimeter" xml:lang="en-US" ' +
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
             'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">',
             ' <metadata name="Application">BambuStudio-01.10.01.50</metadata>',
             ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
             ` <metadata name="Title">${esc(title)}</metadata>`,
             ' <resources>'];
  const cfg = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>'];
  const build = [];
  let nid = 1;

  for (const obj of objects) {
    const ids = [];
    for (const part of obj.parts) {
      const mesh = part.mesh.getMesh();
      const P = mesh.vertProperties, np = mesh.numProp;
      m.push(`  <object id="${nid}" type="model">`, '   <mesh>', '    <vertices>');
      for (let v = 0; v < P.length / np; v++) {
        m.push(`     <vertex x="${P[v * np].toFixed(6)}" ` +
               `y="${P[v * np + 1].toFixed(6)}" ` +
               `z="${P[v * np + 2].toFixed(6)}"/>`);
      }
      m.push('    </vertices>', '    <triangles>');
      for (let t = 0; t < mesh.triVerts.length; t += 3) {
        m.push(`     <triangle v1="${mesh.triVerts[t]}" ` +
               `v2="${mesh.triVerts[t + 1]}" v3="${mesh.triVerts[t + 2]}"/>`);
      }
      m.push('    </triangles>', '   </mesh>', '  </object>');
      ids.push({id: nid, name: part.name, extruder: part.extruder});
      nid++;
    }

    const cid = nid++;
    m.push(`  <object id="${cid}" type="model">`, '   <components>');
    for (const i of ids) {
      m.push(`    <component objectid="${i.id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`);
    }
    m.push('   </components>', '  </object>');
    build.push(`  <item objectid="${cid}" transform="1 0 0 0 1 0 0 0 1 ` +
               `${obj.pos[0].toFixed(4)} ${obj.pos[1].toFixed(4)} 0" printable="1"/>`);

    cfg.push(`  <object id="${cid}">`,
             `    <metadata key="name" value="${esc(obj.name)}"/>`,
             '    <metadata key="extruder" value="1"/>');
    ids.forEach((i, k) => {
      // <part id> must equal the mesh object's id or the slicer silently
      // assigns the wrong filament.
      cfg.push(`    <part id="${i.id}" subtype="normal_part">`,
               `      <metadata key="name" value="${esc(i.name)}"/>`,
               '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>',
               '      <metadata key="source_object_id" value="0"/>',
               `      <metadata key="source_volume_id" value="${k}"/>`,
               `      <metadata key="extruder" value="${i.extruder}"/>`,
               '      <mesh_stat edges_fixed="0" degenerate_facets="0" ' +
               'facets_removed="0" facets_reversed="0" backwards_edges="0"/>',
               '    </part>');
    });
    cfg.push('  </object>');
  }

  m.push(' </resources>', ' <build>', ...build, ' </build>', '</model>');
  cfg.push('</config>');

  const enc = new TextEncoder();
  const entries = [
    {name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES)},
    {name: '_rels/.rels', data: enc.encode(RELS)},
    {name: '3D/3dmodel.model', data: enc.encode(m.join('\n'))},
    {name: 'Metadata/model_settings.config', data: enc.encode(cfg.join('\n'))},
  ];
  if (filaments) {
    // "filament_colour" is Bambu's spelling of their own key. It is wire
    // format, not prose -- do not Americanize it.
    entries.push({
      name: 'Metadata/project_settings.config',
      data: enc.encode(JSON.stringify({
        filament_colour: filaments.map((f) => f.color || ''),
        filament_type: filaments.map((f) => f.type),
      }, null, 2)),
    });
  }
  return zip(entries);
}
