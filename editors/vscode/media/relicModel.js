// Shared model for the Relic Editor - parses relics out of an AMD document and writes
// single fields back, surgically.
//
// WHY THIS IS SMALL. The GUI editor's model had to parse arbitrary MAST - loops,
// conditionals, dynamic values - so it settled for owning a delimited region. A relic is
// a row of numbers in a format that is already declarative, so there is nothing to defeat
// the parser and nothing to regenerate wholesale.
//
// THE WRITE RULE, and it is the whole design: an edit rewrites ONE LINE and touches
// nothing else. Not the record, not the fence, not the file - the line. Prose, comments,
// field order, spelling and blank lines all survive because they are never re-emitted.
// `parse -> write -> parse` is therefore stable by construction rather than by a
// generator that happens to agree with the parser.
//
// The AMD shape it reads (see sbs_utils/procedural/amd_relics.py):
//   a record carrying `Relic:` is a PART of that relic; one carrying none IS the relic.
//   Which kind of part follows from the field it carries - Chamber:, Box: or Solid:.

'use strict';

const HEADING = /^(#{1,6})\s*\[([^\]]*)\]\(([^)]*)\)\s*$/;
const FENCE = /^---\s*$/;
const FIELD = /^([A-Za-z][A-Za-z0-9 _-]*):(.*)$/;

/** Every number in a value, in order. Words are skipped, so `hub 300` yields [300]. */
function numbers(value) {
  const out = [];
  for (const part of String(value).replace(/,/g, ' ').split(/\s+/)) {
    if (part === '') continue;
    const n = Number(part);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Every non-numeric word - the names in `hub 300, gallery 240`. */
function words(value) {
  const out = [];
  for (const part of String(value).replace(/,/g, ' ').split(/\s+/)) {
    if (part === '') continue;
    if (!Number.isFinite(Number(part))) out.push(part);
  }
  return out;
}

/**
 * Parse a whole AMD document.
 *
 * Returns { relics: [...] }, each relic carrying its parts. A part whose `Relic:` names
 * no relic in the file is kept in `orphans` rather than dropped - the editor should be
 * able to SHOW you the mistake the linter is complaining about, not hide it.
 */
function parse(text) {
  const lines = String(text).split(/\r?\n/);
  const records = [];
  let cur = null;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = HEADING.exec(line);
    if (h && !inFence) {
      cur = {
        level: h[1].length, name: h[2], key: h[3],
        headingLine: i, fields: {}, order: [],
      };
      records.push(cur);
      continue;
    }
    if (FENCE.test(line)) { inFence = !inFence; continue; }
    if (!inFence || !cur) continue;
    if (/^\s/.test(line)) continue;          // indented lines are inside a nested block
    const f = FIELD.exec(line);
    if (!f) continue;
    const label = f[1].trim();
    const key = label.toLowerCase();
    cur.fields[key] = { label, value: f[2].trim(), line: i };
    cur.order.push(key);
  }

  const relics = [];
  const byKey = new Map();
  const parts = [];
  for (const r of records) {
    if (r.fields['relic']) { parts.push(r); continue; }
    // Only a record that actually looks like a relic - one with relic-ish fields - is
    // taken as a bed. Otherwise every Job heading in the file becomes an empty relic.
    if (!(r.fields['loc'] || r.fields['atmosphere'] || r.fields['containment'] ||
          r.fields['chamber'] || r.fields['box'] || r.fields['solid'])) continue;
    const relic = {
      key: r.key, name: r.name, headingLine: r.headingLine, fields: r.fields,
      chambers: [], boxes: [], solids: [], passages: [], orphans: [],
      loc: r.fields['loc'] ? numbers(r.fields['loc'].value).slice(0, 3) : [0, 0, 0],
    };
    relics.push(relic);
    byKey.set(r.key, relic);
  }
  for (const p of parts) {
    const owner = byKey.get(String(p.fields['relic'].value).trim());
    const part = {
      key: p.key, name: p.name, headingLine: p.headingLine, fields: p.fields,
    };
    if (!owner) { if (relics[0]) relics[0].orphans.push(part); continue; }
    if (p.fields['chamber']) {
      const n = numbers(p.fields['chamber'].value);
      owner.chambers.push(Object.assign(part, {
        kind: 'chamber', x: n[0], y: n[1], z: n[2], r: n[3],
        line: p.fields['chamber'].line,
      }));
    } else if (p.fields['box']) {
      const n = numbers(p.fields['box'].value);
      owner.boxes.push(Object.assign(part, {
        kind: 'box', x: n[0], y: n[1], z: n[2], hx: n[3], hy: n[4], hz: n[5],
        line: p.fields['box'].line,
      }));
    } else if (p.fields['solid']) {
      const n = numbers(p.fields['solid'].value);
      const w = words(p.fields['solid'].value);
      const shape = (w[0] || 'sphere').toLowerCase();
      // Normalise every shape to a DRAW POSITION and a DRAW RADIUS, because the three
      // carry their numbers differently and the view must not have to know that:
      //   sphere   x y z r
      //   box      x y z hx hy hz
      //   capsule  ax ay az bx by bz r      <- two points, radius LAST
      // A capsule draws at its midpoint. Leaving x/y/z unset here rendered
      // cx="undefined" and no solid appeared at all.
      const solid = Object.assign(part, {
        kind: 'solid', shape, nums: n, line: p.fields['solid'].line,
      });
      if (shape === 'capsule') {
        solid.ax = n[0]; solid.ay = n[1]; solid.az = n[2];
        solid.bx = n[3]; solid.by = n[4]; solid.bz = n[5];
        solid.r = n[6];
        solid.x = (n[0] + n[3]) / 2; solid.y = (n[1] + n[4]) / 2; solid.z = (n[2] + n[5]) / 2;
      } else if (shape === 'box') {
        solid.x = n[0]; solid.y = n[1]; solid.z = n[2];
        solid.hx = n[3]; solid.hy = n[4]; solid.hz = n[5];
        solid.r = n[3];
      } else {
        solid.x = n[0]; solid.y = n[1]; solid.z = n[2];
        solid.r = n[3];
      }
      owner.solids.push(solid);
    }
    const pass = p.fields['passage to'];
    if (pass) {
      for (const group of String(pass.value).split(',')) {
        const w = words(group), n = numbers(group);
        if (!w.length) continue;
        owner.passages.push({
          from: p.key, to: w[0], radius: n.length ? n[0] : null, line: pass.line,
        });
      }
    }
  }
  return { relics, lines };
}

/**
 * Rewrite ONE field on ONE record, preserving the author's own spelling of the label and
 * everything else in the file.
 *
 * `values` is the new list of numbers. A `prefix` (a solid's shape word) is re-emitted
 * ahead of them. Returns the new text, or the original if the field is not there - a
 * caller asking to move something that does not exist must not silently corrupt the file.
 */
function writeField(text, lineNo, values, prefix) {
  const lines = String(text).split(/\r?\n/);
  if (lineNo < 0 || lineNo >= lines.length) return text;
  const f = FIELD.exec(lines[lineNo]);
  if (!f) return text;
  const label = f[1];
  const nums = values.map(fmt).join(', ');
  lines[lineNo] = label + ': ' + (prefix ? prefix + ', ' : '') + nums;
  return lines.join('\n');
}

/** Numbers as an author would write them: no trailing `.0`, no exponent noise. */
function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : String(r);
}

/** Move a chamber or box to a new XZ, keeping its height and size. */
function moveePart(text, part, x, z) {
  if (part.kind === 'chamber') {
    return writeField(text, part.line, [x, part.y, z, part.r]);
  }
  if (part.kind === 'box') {
    return writeField(text, part.line, [x, part.y, z, part.hx, part.hy, part.hz]);
  }
  if (part.kind === 'solid') {
    const n = part.nums.slice();
    if (part.shape === 'capsule') {
      // BOTH endpoints move, or the capsule stretches instead of translating.
      const dx = x - part.x;
      const dz = z - part.z;
      n[0] += dx; n[2] += dz;
      n[3] += dx; n[5] += dz;
    } else {
      n[0] = x; n[2] = z;
    }
    return writeField(text, part.line, n, part.shape);
  }
  return text;
}

/** Set a chamber's radius (or a box's half-extents / a solid's size) without moving it. */
function resizePart(text, part, value) {
  if (part.kind === 'chamber') {
    return writeField(text, part.line, [part.x, part.y, part.z, value]);
  }
  if (part.kind === 'box') {
    return writeField(text, part.line, [part.x, part.y, part.z, value, part.hy, part.hz]);
  }
  return text;
}

/** Set a chamber's height (y) without moving it on the plan. */
function setHeight(text, part, y) {
  if (part.kind === 'chamber') {
    return writeField(text, part.line, [part.x, y, part.z, part.r]);
  }
  if (part.kind === 'box') {
    return writeField(text, part.line, [part.x, y, part.z, part.hx, part.hy, part.hz]);
  }
  return text;
}

module.exports = {
  parse, writeField, movePart: moveePart, resizePart, setHeight, numbers, words, fmt,
};
