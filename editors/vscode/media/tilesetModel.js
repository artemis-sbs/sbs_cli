// Shared model for the Tileset Editor - reads a TILESET file (.tileset) and rewrites one
// kind line at a time.
//
// THE FORMAT (sbs_utils/procedural/tilemap.py, `tilemap_tileset_parse`):
//
//   tileset: mereth
//   title: Mereth surface
//   kinds:
//     dust:        walk see   look=dirt       # each word is a rule the kind HAS
//     brine:            see   look=water
//     rock:                   look=rock
//
// THE WRITE RULE, as in tilesModel.js: an edit rewrites ONE line. And it keeps the
// file's own alignment - authors line these files up in columns, so each rule is put at
// the column that rule already sits at in the rest of the file.
//
// Loaded by `require()` in the extension host and its node tests, and by a <script> in
// the webview, where it becomes `window.TilesetModel`.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.TilesetModel = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FLAGS = ['walk', 'see', 'tall'];
  const VALUES = ['look', 'cell', 'color', 'over'];
  const ORDER = FLAGS.concat(VALUES);

  function norm(s) { return String(s || '').trim().toLowerCase(); }

  /** Where everything is. Line numbers are 0-based. */
  function parse(text) {
    const lines = String(text || '').split(/\r?\n/);
    const m = { eol: /\r\n/.test(String(text || '')) ? '\r\n' : '\n', lines, header: {},
                kindsLine: -1, lastKindLine: -1, kinds: [], errors: [] };
    let inKinds = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const s = raw.trim();
      if (!s || s.startsWith('#')) { continue; }
      if (raw[0] !== ' ' && raw[0] !== '\t') {
        const c = s.indexOf(':');
        const key = (c < 0 ? s : s.slice(0, c)).trim().toLowerCase();
        const value = c < 0 ? '' : s.slice(c + 1).trim();
        if (key === 'kinds' && !value) { inKinds = true; m.kindsLine = i; continue; }
        inKinds = false;
        m.header[key] = { line: i, value };
        continue;
      }
      if (!inKinds) { continue; }
      const indent = raw.slice(0, raw.length - raw.trimStart().length);
      const c = s.indexOf(':');
      if (c < 0) { m.errors.push({ line: i, message: 'a kind line is "name: rules"' }); continue; }
      const name = norm(s.slice(0, c));
      const rules = { walk: false, see: false, tall: false };
      const cols = {};
      let comment = null, commentCol = null;
      const re = /\S+/g;
      let tok;
      const restStart = raw.indexOf(':') + 1;
      re.lastIndex = restStart;
      while ((tok = re.exec(raw)) !== null) {
        const word = tok[0];
        if (word.startsWith('#')) { comment = raw.slice(tok.index); commentCol = tok.index; break; }
        const eq = word.indexOf('=');
        const key = (eq < 0 ? word : word.slice(0, eq)).toLowerCase();
        if (eq < 0 && FLAGS.includes(key)) { rules[key] = true; cols[key] = tok.index; }
        else if (eq > 0 && VALUES.includes(key)) {
          rules[key] = key === 'over' ? Number(word.slice(eq + 1)) : word.slice(eq + 1);
          cols[key] = tok.index;
        } else { m.errors.push({ line: i, message: `"${word}" is not a rule` }); }
      }
      m.kinds.push({ name, line: i, indent, rules, cols, comment, commentCol });
      m.lastKindLine = i;
    }
    return m;
  }

  /** The column each rule sits at in most of the file's lines - its alignment. */
  function columns(m) {
    const out = {};
    for (const key of ORDER.concat(['#'])) {
      const count = {};
      for (const k of m.kinds) {
        const c = key === '#' ? k.commentCol : k.cols[key];
        if (c != null) { count[c] = (count[c] || 0) + 1; }
      }
      const best = Object.keys(count).sort((a, b) => count[b] - count[a] || a - b)[0];
      if (best !== undefined) { out[key] = Number(best); }
    }
    return out;
  }

  /** One kind line, aligned to the file's columns where it can be. */
  function formatLine(m, name, rules, comment, indent) {
    const cols = columns(m);
    let line = (indent != null ? indent : (m.kinds[0] ? m.kinds[0].indent : '  ')) + norm(name) + ':';
    const put = (col, text) => {
      if (col != null && line.length < col) { line += ' '.repeat(col - line.length); }
      else { line += ' '; }
      line += text;
    };
    for (const key of ORDER) {
      const v = rules[key];
      if (FLAGS.includes(key)) { if (v) { put(cols[key], key); } }
      else if (v !== undefined && v !== null && v !== '' && !(key === 'over' && !Number.isFinite(Number(v)))) {
        put(cols[key], key + '=' + v);
      }
    }
    if (comment) { put(cols['#'] != null ? cols['#'] : line.length + 2, comment); }
    return line.replace(/\s+$/, '');
  }

  function kindOf(m, name) { return m.kinds.find((k) => k.name === norm(name)); }

  /** Rewrite one kind's line (optionally renaming it), keeping its indent and comment. */
  function kindEdit(m, oldName, name, rules) {
    const k = kindOf(m, oldName);
    if (!k) { return addEdit(m, name, rules); }
    return { start: k.line, end: k.line + 1, text: formatLine(m, name, rules, k.comment, k.indent) + m.eol };
  }

  /** A new kind, after the last one (or a new `kinds:` block at the end). */
  function addEdit(m, name, rules) {
    const line = formatLine(m, name, rules || {}, null, null) + m.eol;
    if (m.lastKindLine >= 0) { return { start: m.lastKindLine + 1, end: m.lastKindLine + 1, text: line }; }
    if (m.kindsLine >= 0) { return { start: m.kindsLine + 1, end: m.kindsLine + 1, text: line }; }
    const last = m.lines[m.lines.length - 1];
    return { start: m.lines.length - 1, end: m.lines.length,
             text: (last ? last + m.eol : '') + 'kinds:' + m.eol + line };
  }

  function removeEdit(m, name) {
    const k = kindOf(m, name);
    return k ? { start: k.line, end: k.line + 1, text: '' } : null;
  }

  /** Set (or add, at the top) a header key - `tileset`, `title`. */
  function headerEdit(m, key, value) {
    const h = m.header[key];
    if (h) {
      const raw = m.lines[h.line];
      return { start: h.line, end: h.line + 1, text: raw.slice(0, raw.indexOf(':') + 1) + ' ' + value + m.eol };
    }
    const before = Object.values(m.header).map((x) => x.line);
    const at = before.length ? Math.max.apply(null, before) + 1 : (m.kindsLine >= 0 ? m.kindsLine : 0);
    return { start: at, end: at, text: key + ': ' + value + m.eol };
  }

  return { parse, columns, formatLine, kindEdit, addEdit, removeEdit, headerEdit, FLAGS, VALUES };
});
