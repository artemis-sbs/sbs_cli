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
    if (FENCE.test(line)) {
      inFence = !inFence;
      // The closing fence is the last line the record owns. Anything after it is prose,
      // which belongs to the record too but is not ours to rewrite.
      if (!inFence && cur) cur.fenceEnd = i;
      continue;
    }
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
      fenceEnd: r.fenceEnd,
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
      fenceEnd: p.fenceEnd,
    };
    if (!owner) { if (relics[0]) relics[0].orphans.push(part); continue; }
    if (p.fields['chamber']) {
      const n = numbers(p.fields['chamber'].value);
      owner.chambers.push(Object.assign(part, {
        kind: 'chamber', x: n[0], y: n[1], z: n[2], r: n[3],
        line: p.fields['chamber'].line, fenceEnd: p.fenceEnd,
      }));
    } else if (p.fields['box']) {
      const n = numbers(p.fields['box'].value);
      owner.boxes.push(Object.assign(part, {
        kind: 'box', x: n[0], y: n[1], z: n[2], hx: n[3], hy: n[4], hz: n[5],
        line: p.fields['box'].line, fenceEnd: p.fenceEnd,
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
        fenceEnd: p.fenceEnd,
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

/** Rewrite a part's DISPLAY TEXT - the `### [display](key)` heading.
 *
 *  The display text is the only thing about a part an author can say in words, and until
 *  now the editor could change every number and not the name. It rewrites one line, like
 *  every other edit here.
 *
 *  The KEY is deliberately untouched. Passages name their ends by key, so renaming one
 *  would silently orphan every corridor that reached it - a rename in an editor should
 *  not be able to disconnect a relic.
 */
function setName(text, part, name) {
  const lines = String(text).split(/\r?\n/);
  const i = part && part.headingLine;
  if (i === undefined || i === null || i < 0 || i >= lines.length) { return text; }
  const m = /^(\s*#{1,6}\s*)\[[^\]]*\](\([^)]*\).*)$/.exec(lines[i]);
  if (!m) { return text; }
  // `]` would end the link text early and `[` opens one; a display name carrying either
  // is not a rename, it is a broken heading.
  const clean = String(name === undefined || name === null ? '' : name)
    .replace(/[\[\]]/g, '').replace(/[\r\n]/g, ' ').trim();
  lines[i] = m[1] + '[' + clean + ']' + m[2];
  return lines.join('\n');
}

/** Numbers as an author would write them: no trailing `.0`, no exponent noise. */
function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : String(r);
}

/**
 * Write a patch of named values onto a part, leaving the rest as they were.
 *
 * One verb for every edit, because the alternative is a function per field that each has
 * to know how the three shapes lay their numbers out. The patch is merged over the part's
 * current values and the whole row is re-emitted - still ONE line, so the write rule
 * holds.
 *
 * Understood keys: x, y, z (position), r (radius, or a capsule's), hx/hy/hz (extents).
 */
function setPart(text, part, patch) {
  const v = {
    x: part.x, y: part.y, z: part.z, r: part.r,
    hx: part.hx, hy: part.hy, hz: part.hz,
  };
  for (const k of Object.keys(patch || {})) {
    if (patch[k] !== undefined && patch[k] !== null && Number.isFinite(Number(patch[k]))) {
      v[k] = Number(patch[k]);
    }
  }
  if (part.kind === 'chamber') {
    return writeField(text, part.line, [v.x, v.y, v.z, v.r]);
  }
  if (part.kind === 'box') {
    return writeField(text, part.line, [v.x, v.y, v.z, v.hx, v.hy, v.hz]);
  }
  if (part.kind === 'solid') {
    if (part.shape === 'capsule') {
      // A capsule has no single centre to write, so a position patch TRANSLATES it and
      // its length is preserved - the same rule dragging one follows.
      const dx = v.x - part.x;
      const dy = v.y - part.y;
      const dz = v.z - part.z;
      return writeField(text, part.line, [
        part.ax + dx, part.ay + dy, part.az + dz,
        part.bx + dx, part.by + dy, part.bz + dz, v.r,
      ], 'capsule');
    }
    if (part.shape === 'box') {
      return writeField(text, part.line, [v.x, v.y, v.z, v.hx, v.hy, v.hz], 'box');
    }
    return writeField(text, part.line, [v.x, v.y, v.z, v.r], part.shape);
  }
  return text;
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

/**
 * Join two chambers with a passage.
 *
 * Appends to the source's existing `Passage to:` if it has one, otherwise inserts the
 * line just after its shape field. This is the first edit that ADDS a line rather than
 * rewriting one - still surgical, because it touches exactly one line either way and
 * inserts inside the fence the field belongs to.
 *
 * Refuses a duplicate and refuses to join a chamber to itself; both would compile into a
 * relic that is subtly wrong rather than obviously broken.
 */
function addPassage(text, from, toKey, radius) {
  if (!from || !toKey || from.key === toKey) return text;
  const lines = String(text).split(/\r?\n/);
  const existing = from.fields && from.fields['passage to'];
  const r = Number.isFinite(Number(radius)) ? Number(radius) : 200;
  if (existing) {
    const already = words(existing.value).indexOf(toKey) >= 0;
    if (already) return text;
    const m = FIELD.exec(lines[existing.line]);
    if (!m) return text;
    lines[existing.line] = m[1] + ':' + (m[2].trim() ? ' ' + m[2].trim() + ',' : '')
      + ' ' + toKey + ' ' + fmt(r);
    return lines.join('\n');
  }
  if (!Number.isFinite(from.line)) return text;
  lines.splice(from.line + 1, 0, 'Passage to: ' + toKey + ' ' + fmt(r));
  return lines.join('\n');
}

/** Drop one passage from a source chamber, removing the line if it was the only one. */
function removePassage(text, from, toKey) {
  const existing = from && from.fields && from.fields['passage to'];
  if (!existing) return text;
  const lines = String(text).split(/\r?\n/);
  const kept = String(existing.value).split(',')
    .filter((g) => words(g)[0] !== toKey)
    .map((g) => g.trim())
    .filter((g) => g !== '');
  if (kept.length === String(existing.value).split(',').filter((g) => g.trim()).length) {
    return text;                       // nothing matched - do not touch the file
  }
  const m = FIELD.exec(lines[existing.line]);
  if (!m) return text;
  if (!kept.length) {
    lines.splice(existing.line, 1);    // an empty `Passage to:` is noise, not data
  } else {
    lines[existing.line] = m[1] + ': ' + kept.join(', ');
  }
  return lines.join('\n');
}

/**
 * Add a chamber to a relic, as a new record after its last part.
 *
 * Written in the shape an author would write by hand - heading, fence, `Relic:`, the
 * shape field - so the file does not develop a machine-written dialect alongside a human
 * one. Nothing else in the document moves.
 */
function addChamber(text, relic, key, x, y, z, r, name) {
  if (!relic || !key) return text;
  const lines = String(text).split(/\r?\n/);
  const parts = [].concat(relic.chambers, relic.boxes, relic.solids);
  let at = relic.fenceEnd;
  for (const p of parts) {
    if (Number.isFinite(p.fenceEnd) && p.fenceEnd > at) at = p.fenceEnd;
  }
  if (!Number.isFinite(at)) return text;
  const block = ['', '### [' + (name || key) + '](' + key + ')', '---',
    'Relic: ' + relic.key,
    'Chamber: ' + [x, y, z, r].map(fmt).join(', '), '---'];
  lines.splice(at + 1, 0, ...block);
  return lines.join('\n');
}

/**
 * Remove a part's whole record, and every passage that named it.
 *
 * The passages matter more than the record: leaving them behind produces a corridor to
 * nothing, which the linter reports as `relic-dangling-passage` and which reads on the
 * plan as a bug rather than a deletion.
 *
 * DELIBERATE LIMIT: the record's PROSE is not removed. Prose lives after the closing
 * fence and is the one thing here a person actually wrote by hand, so it is never
 * destroyed on a click - an orphaned paragraph is easy to see and delete, and impossible
 * to get back if this guessed wrong.
 */
function removePart(text, relic, part) {
  if (!part || !Number.isFinite(part.headingLine) || !Number.isFinite(part.fenceEnd)) {
    return text;
  }
  let out = text;
  for (const other of [].concat(relic.chambers, relic.boxes)) {
    if (other.key === part.key) continue;
    out = removePassage(out, R_reparse(out, relic.key, other.key) || other, part.key);
  }
  const lines = out.split(/\r?\n/);
  // Re-find the record: removing passages above it may have shifted its lines.
  const fresh = R_reparse(out, relic.key, part.key);
  const head = fresh ? fresh.headingLine : part.headingLine;
  const tail = fresh ? fresh.fenceEnd : part.fenceEnd;
  if (!Number.isFinite(head) || !Number.isFinite(tail) || tail < head) return out;
  let from = head;
  while (from > 0 && lines[from - 1].trim() === '') from--;   // take the blank line too
  lines.splice(from, tail - from + 1);
  return lines.join('\n');
}

/** Find a part again after the text has shifted under us. */
function R_reparse(text, relicKey, partKey) {
  const m = parse(text);
  const rel = m.relics.find((r) => r.key === relicKey);
  if (!rel) return null;
  return [].concat(rel.chambers, rel.boxes, rel.solids)
    .find((p) => p.key === partKey) || null;
}

module.exports = {
  setName,
  parse, writeField, movePart: moveePart, resizePart, setHeight, setPart,
  addPassage, removePassage, addChamber, removePart,
  numbers, words, fmt,
};
