// Shared model for the Tile Map Editor - reads a tile AREA file (.tiles) and writes the
// grid back, row by row.
//
// THE FORMAT (sbs_utils/procedural/tilemap.py, `tilemap_parse`):
//
//   area: ridge
//   tileset: mereth
//   entry: landing                  <- a mark name, or "x, y"
//   legend:
//     .: dust                       <- ONE character, a colon, a kind
//     L: dust @landing              <- ... and optionally a mark on the cell
//   exits:
//     to_colony: colony @to_ridge
//   ---
//   #####                           <- the map, row 0 first; a space is "nothing"
//
// THE WRITE RULE, as in relicModel.js: an edit rewrites only the LINES it changes. A
// paint stroke replaces the map rows it touched and nothing else, so comments, header
// order and the legend's own spacing survive every edit - and VS Code's undo sees one
// small edit per stroke.
//
// Loaded two ways: `require()` in the extension host and its node tests, and a plain
// <script> in the webview, where it becomes `window.TilesModel`.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.TilesModel = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function splitLines(text) { return String(text || '').split(/\r?\n/); }

  function norm(s) { return String(s || '').trim().toLowerCase(); }

  /** Where everything is. Line numbers are 0-based. */
  function parse(text) {
    const lines = splitLines(text);
    const m = {
      eol: /\r\n/.test(String(text || '')) ? '\r\n' : '\n',
      lines, header: {}, legend: [], exits: [],
      legendLine: -1, exitsLine: -1, lastLegendLine: -1,
      sep: -1, rows: [], width: 0, height: 0, size: null,
    };
    let block = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const s = raw.trim();
      if (s.startsWith('---')) { m.sep = i; break; }
      if (!s || raw.startsWith('#')) { continue; }
      if (raw[0] !== ' ' && raw[0] !== '\t') {
        const c = s.indexOf(':');
        const key = (c < 0 ? s : s.slice(0, c)).trim().toLowerCase();
        const value = c < 0 ? '' : s.slice(c + 1).trim();
        if ((key === 'legend' || key === 'exits') && !value) {
          block = key;
          if (key === 'legend') { m.legendLine = i; } else { m.exitsLine = i; }
          continue;
        }
        block = null;
        m.header[key] = { line: i, value };
        continue;
      }
      if (block === 'legend') {
        const ch = s[0];
        const rest = s.slice(1);
        if (!rest.startsWith(':')) { continue; }
        const at = rest.indexOf('@');
        const kind = norm(at < 0 ? rest.slice(1) : rest.slice(1, at));
        const mark = at < 0 ? null : (norm(rest.slice(at + 1)) || null);
        const prev = m.legend.findIndex((e) => e.ch === ch);
        if (prev >= 0) { m.legend.splice(prev, 1); }      // the parser: later wins
        m.legend.push({ ch, kind, mark, line: i });
        m.lastLegendLine = i;
      } else if (block === 'exits') {
        const c = s.indexOf(':');
        m.exits.push({ mark: norm(s.slice(0, c)), to: s.slice(c + 1).trim(), line: i });
      }
    }
    if (m.sep >= 0) {
      const rows = lines.slice(m.sep + 1);
      while (rows.length && !rows[rows.length - 1].trim()) { rows.pop(); }
      m.rows = rows;
    }
    m.width = m.rows.reduce((w, r) => Math.max(w, r.length), 0);
    m.height = m.rows.length;
    const size = m.header.size && /^(\d+)\s*x\s*(\d+)$/i.exec(m.header.size.value);
    if (size) {
      m.size = { w: +size[1], h: +size[2] };
      m.width = m.size.w;
      m.height = m.size.h;
    }
    return m;
  }

  /** The map as a grid of characters, `width` x `height`, padded with spaces. */
  function grid(m) {
    const out = [];
    for (let y = 0; y < m.height; y++) {
      const row = m.rows[y] || '';
      out.push((row + ' '.repeat(Math.max(0, m.width - row.length))).slice(0, m.width).split(''));
    }
    return out;
  }

  function rowText(cells) { return cells.join('').replace(/\s+$/, ''); }

  /**
   * The line edits that turn the map into `cells` (a grid of characters): one per map
   * row that changed, plus rows added or taken away at the bottom. Trailing spaces are
   * dropped - the parser pads a short row with "nothing", so they mean nothing.
   *
   * Returns [{ start, end, text }]: replace lines start..end-1 (0-based, end exclusive)
   * with `text` (which carries its own line endings; '' deletes).
   */
  function rowEdits(m, cells) {
    const edits = [];
    const eol = m.eol;
    if (m.sep < 0) {
      // No map yet: the separator and the rows go at the end, after the last line.
      const last = m.lines[m.lines.length - 1];
      const body = cells.map((r) => rowText(r) + eol).join('');
      edits.push({ start: m.lines.length - 1, end: m.lines.length,
                   text: (last ? last + eol : '') + '---' + eol + body });
      return edits;
    }
    const base = m.sep + 1;
    const oldRows = m.rows;
    const shared = Math.min(oldRows.length, cells.length);
    for (let y = 0; y < shared; y++) {
      const t = rowText(cells[y]);
      if (t !== oldRows[y]) { edits.push({ start: base + y, end: base + y + 1, text: t + eol }); }
    }
    if (cells.length > oldRows.length) {
      const extra = cells.slice(oldRows.length).map((r) => rowText(r) + eol).join('');
      const at = base + oldRows.length;
      edits.push({ start: at, end: at, text: extra });
    } else if (cells.length < oldRows.length) {
      edits.push({ start: base + cells.length, end: base + oldRows.length, text: '' });
    }
    // A `size:` header decides the map's size over its rows, so it follows a resize.
    if (m.size && cells.length && (cells[0].length !== m.size.w || cells.length !== m.size.h)) {
      edits.push(headerEdit(m, 'size', cells[0].length + 'x' + cells.length));
    }
    return edits;
  }

  /**
   * Apply edits to text the way VS Code applies `Range(start, 0, end, 0)`: a line past
   * the end clamps to the end of the text. Used by the tests, so they check what the
   * editor will actually write.
   */
  function applyEdits(text, edits) {
    text = String(text || '');
    const starts = [0];
    for (let i = 0; i < text.length; i++) { if (text[i] === '\n') { starts.push(i + 1); } }
    const at = (line) => (line < starts.length ? starts[line] : text.length);
    const sorted = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end);
    for (const e of sorted) {
      text = text.slice(0, at(e.start)) + e.text + text.slice(at(e.end));
    }
    return text;
  }

  /** Set (or add) one header key - `entry`, `size`, `title`. */
  function headerEdit(m, key, value) {
    const h = m.header[key];
    if (h) {
      const raw = m.lines[h.line];
      const c = raw.indexOf(':');
      return { start: h.line, end: h.line + 1, text: raw.slice(0, c + 1) + ' ' + value + m.eol };
    }
    // After the last header line above the legend, else at the top.
    const before = Object.values(m.header).map((x) => x.line)
      .filter((l) => m.legendLine < 0 || l < m.legendLine);
    const at = before.length ? Math.max.apply(null, before) + 1 : 0;
    return { start: at, end: at, text: key + ': ' + value + m.eol };
  }

  /** Add a legend entry: `ch: kind` or `ch: kind @mark`. */
  function legendAddEdit(m, ch, kind, mark) {
    const line = '  ' + ch + ': ' + norm(kind) + (mark ? ' @' + norm(mark) : '') + m.eol;
    if (m.lastLegendLine >= 0) {
      return { start: m.lastLegendLine + 1, end: m.lastLegendLine + 1, text: line };
    }
    if (m.legendLine >= 0) {
      return { start: m.legendLine + 1, end: m.legendLine + 1, text: line };
    }
    const at = m.exitsLine >= 0 ? m.exitsLine : (m.sep >= 0 ? m.sep : m.lines.length);
    return { start: at, end: at, text: 'legend:' + m.eol + line };
  }

  /** Change an existing legend entry's kind and mark, keeping its character. */
  function legendSetEdit(m, ch, kind, mark) {
    const e = m.legend.find((x) => x.ch === ch);
    if (!e) { return legendAddEdit(m, ch, kind, mark); }
    const raw = m.lines[e.line];
    const indent = raw.slice(0, raw.length - raw.trimStart().length);
    return { start: e.line, end: e.line + 1,
             text: indent + ch + ': ' + norm(kind) + (mark ? ' @' + norm(mark) : '') + m.eol };
  }

  // Characters offered for a new legend entry, in order of preference after the kind's
  // own initial. None of them is special to the parser: `#` is fine as a key (a comment
  // is only a `#` in column 0), and a space is "nothing", so it is never offered.
  const POOL = '.,:;#~=+*^%&$!?-_/|<>()[]{}0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

  /** A character the legend does not use yet, preferring the kind's initial. */
  function freeChar(m, kind) {
    const used = new Set(m.legend.map((e) => e.ch));
    const k = norm(kind);
    for (const c of [k[0], (k[0] || '').toUpperCase()].concat(POOL.split(''))) {
      if (c && c !== ' ' && !used.has(c)) { return c; }
    }
    return null;
  }

  // --- tools (pure: take a grid, return a new one) ---------------------------------

  function clone(cells) { return cells.map((r) => r.slice()); }

  function paint(cells, x, y, ch) {
    if (y < 0 || y >= cells.length || x < 0 || x >= cells[y].length || cells[y][x] === ch) { return cells; }
    const out = clone(cells);
    out[y][x] = ch;
    return out;
  }

  /** Every cell on the straight line between two cells - a fast drag leaves no gaps. */
  function line(x0, y0, x1, y1) {
    const pts = [];
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let i = 0; i < 10000; i++) {
      pts.push([x0, y0]);
      if (x0 === x1 && y0 === y1) { break; }
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return pts;
  }

  function rect(cells, x0, y0, x1, y1, ch, outline) {
    const out = clone(cells);
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    for (let y = Math.max(0, ay); y <= Math.min(by, out.length - 1); y++) {
      for (let x = Math.max(0, ax); x <= Math.min(bx, (out[y] || []).length - 1); x++) {
        if (!outline || x === ax || x === bx || y === ay || y === by) { out[y][x] = ch; }
      }
    }
    return out;
  }

  /** Four-connected flood fill of the region the start cell belongs to. */
  function fill(cells, x, y, ch) {
    if (y < 0 || y >= cells.length || x < 0 || x >= cells[y].length) { return cells; }
    const from = cells[y][x];
    if (from === ch) { return cells; }
    const out = clone(cells);
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cy < 0 || cy >= out.length || cx < 0 || cx >= out[cy].length || out[cy][cx] !== from) { continue; }
      out[cy][cx] = ch;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    return out;
  }

  /** A new size: rows and columns are cut or padded with "nothing" at the right/bottom. */
  function resize(cells, w, h) {
    const out = [];
    for (let y = 0; y < h; y++) {
      const row = (cells[y] || []).slice(0, w);
      while (row.length < w) { row.push(' '); }
      out.push(row);
    }
    return out;
  }

  /**
   * Move a MARK: every cell drawn with a character that carries `mark`, shifted by
   * (dx, dy), each keeping its own character. What a thing placed by `Mark:` stands on
   * is the mark, so moving the thing means repainting the mark.
   *
   * A vacated cell becomes the plain ground of the same kind (the legend character with
   * that kind and no mark); failing that, the plain character most common around it;
   * failing that, nothing. Returns the new grid, or null when the mark would leave the
   * map or is not on it.
   */
  function moveMark(m, cells, mark, dx, dy) {
    const byCh = {};
    for (const e of m.legend) { byCh[e.ch] = e; }
    const mine = [];
    cells.forEach((row, y) => row.forEach((ch, x) => {
      if (byCh[ch] && byCh[ch].mark === mark) { mine.push([x, y, ch]); }
    }));
    if (!mine.length) { return null; }
    const h = cells.length, w = h ? cells[0].length : 0;
    if (mine.some(([x, y]) => x + dx < 0 || y + dy < 0 || x + dx >= w || y + dy >= h)) { return null; }
    const out = clone(cells);
    const moving = new Set(mine.map(([x, y]) => x + ',' + y));
    const plainOf = (kind) => (m.legend.find((e) => e.kind === kind && !e.mark) || {}).ch;
    for (const [x, y, ch] of mine) {
      let fill = plainOf(byCh[ch].kind);
      if (!fill) {
        const count = {};
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          const c = cells[ny] && cells[ny][nx];
          if (c && !moving.has(nx + ',' + ny) && byCh[c] && !byCh[c].mark) { count[c] = (count[c] || 0) + 1; }
        }
        fill = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || ' ';
      }
      out[y][x] = fill;
    }
    for (const [x, y, ch] of mine) { out[y + dy][x + dx] = ch; }
    return out;
  }

  /**
   * A kind renamed in the tileset, followed into this area's legend: an edit for every
   * legend line that draws `oldKind`, replacing ONLY that word - so the line's own
   * spacing, its character and its mark stay exactly as written.
   */
  function renameKindEdits(m, oldKind, newKind) {
    const edits = [];
    if (m.legendLine < 0) { return edits; }
    const from = norm(oldKind);
    for (let i = m.legendLine + 1; i < m.lines.length; i++) {
      const raw = m.lines[i];
      if (raw.trim().startsWith('---')) { break; }
      if (!raw.trim()) { continue; }
      if (raw[0] !== ' ' && raw[0] !== '\t') { break; }   // the next header key ends the block
      const at = raw.length - raw.trimStart().length;     // the key character
      if (raw[at + 1] !== ':') { continue; }
      let s = at + 2;
      while (s < raw.length && (raw[s] === ' ' || raw[s] === '\t')) { s++; }
      let e = s;
      while (e < raw.length && !/[\s@]/.test(raw[e])) { e++; }
      if (raw.slice(s, e).toLowerCase() === from) {
        edits.push({ start: i, end: i + 1, text: raw.slice(0, s) + norm(newKind) + raw.slice(e) + m.eol });
      }
    }
    return edits;
  }

  /** `x, y` or `x y` -> [x, y], or null. What an At: or a Patrol point holds. */
  function parseCell(s) {
    const n = String(s || '').replace(/,/g, ' ').trim().split(/\s+/).map(Number);
    return n.length >= 2 && n.every(Number.isFinite) ? [n[0], n[1]] : null;
  }

  /** The cell each lint finding points at, when it points into the map. */
  function cellOfLine(m, line, character) {
    if (m.sep < 0 || line <= m.sep) { return null; }
    const y = line - m.sep - 1;
    return y < m.height ? { x: character, y } : null;
  }

  return { parse, grid, rowEdits, applyEdits, headerEdit, legendAddEdit, legendSetEdit,
           freeChar, paint, line, rect, fill, resize, cellOfLine, parseCell, moveMark, renameKindEdits, rowText };
});
