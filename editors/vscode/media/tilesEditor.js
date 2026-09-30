// Tile Map Editor - the webview half. Draws a tile AREA file (.tiles) on a canvas and
// paints it.
//
// The DOCUMENT is the source of truth. This page keeps a parsed copy (TilesModel), paints
// into it for instant feedback, and at the end of each stroke sends the new rows to the
// extension, which writes only the changed lines. What a cell LOOKS like in the game
// (edges, fringes, variants, shade) is never computed here: the extension asks the
// language server (`tiles/preview`, which runs the game's own Python) and hands the
// answer over. Until it comes back, a freshly painted cell shows its kind's color.
/* global TilesModel, acquireVsCodeApi */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const M = TilesModel;
  const $ = (id) => document.getElementById(id);

  const saved = vscode.getState() || {};
  const S = {
    text: '', model: null, cells: [],
    preview: null, sheets: {}, images: {}, dirty: new Set(), problemCells: new Map(),
    tool: saved.tool || 'paint', brush: saved.brush || null,
    mode: saved.mode || 'kinds', zoom: saved.zoom || 28,
    grid: saved.grid !== false, marks: saved.marks !== false, chars: !!saved.chars,
    things: saved.things !== false,
    stroke: null, hover: null, pendingText: null,
    drag: null, sel: null,               // a thing (or patrol point) being moved; the selected key
  };

  function keep() {
    vscode.setState({ tool: S.tool, brush: S.brush, mode: S.mode, zoom: S.zoom,
                      grid: S.grid, marks: S.marks, chars: S.chars, things: S.things });
  }

  // --- the document ------------------------------------------------------------------

  function loadText(text) {
    S.text = text;
    S.model = M.parse(text);
    S.cells = M.grid(S.model);
    if (S.brush === null || !legendOf(S.brush)) {
      S.brush = S.model.legend.length ? S.model.legend[0].ch : ' ';
    }
    for (const [id, v] of [['rw', S.cells.length ? S.cells[0].length : ''], ['rh', S.cells.length || '']]) {
      if (document.activeElement !== $(id)) { $(id).value = v; }
    }
    mapProblems();
    renderPalette();
    renderInfo();
    draw();
  }

  function legendOf(ch) { return S.model && S.model.legend.find((e) => e.ch === ch); }

  function send(type, data) { vscode.postMessage(Object.assign({ type }, data || {})); }

  function commit() {
    send('setRows', { rows: S.cells.map((r) => r.join('')) });
  }

  // --- colors ------------------------------------------------------------------------

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return h;
  }

  function kindInfo(kind) {
    const p = S.preview || {};
    return (p.kinds && p.kinds[kind]) || (p.tilesetKinds && p.tilesetKinds[kind]) || null;
  }

  function kindColor(kind) {
    const info = kindInfo(kind);
    if (info && info.color) { return info.color; }
    const walk = info ? info.walk : null;
    const light = walk === false ? (info.see ? 32 : 20) : 44;
    return 'hsl(' + (hash(kind) % 360) + ',38%,' + light + '%)';
  }

  let hatch = null;
  function hatchPattern(ctx) {
    if (hatch) { return hatch; }
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, 8); g.lineTo(8, 0); g.stroke();
    hatch = ctx.createPattern(c, 'repeat');
    return hatch;
  }

  // --- art -----------------------------------------------------------------------------

  function image(uri) {
    if (!S.images[uri]) {
      const img = new Image();
      img.onload = () => draw();
      img.src = uri;
      S.images[uri] = img;
    }
    return S.images[uri];
  }

  // A sprite cut from its sheet, TINTED the way the game tints: each channel multiplied
  // by the color, alpha untouched (preview_map.py's `tint`). Cached per rect and color.
  const cut = {};
  function spriteCanvas(key, color) {
    const sp = S.preview && S.preview.sprites[key];
    if (!sp) { return null; }
    const uri = S.sheets[sp.sheet];
    if (!uri) { return null; }
    const img = image(uri);
    if (!img.complete || !img.naturalWidth) { return null; }
    const id = uri + '|' + sp.rect.join(',') + '|' + (color || '');
    if (cut[id]) { return cut[id]; }
    const [x0, y0, x1, y1] = sp.rect;
    const c = document.createElement('canvas');
    c.width = x1 - x0;
    c.height = y1 - y0;
    const g = c.getContext('2d');
    g.drawImage(img, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
    if (color) {
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = color;
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = 'destination-in';          // put the alpha back
      g.drawImage(img, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
    }
    cut[id] = c;
    return c;
  }

  function drawSprite(ctx, key, px, py, z) {
    const sp = S.preview && S.preview.sprites[key];
    const c = sp && spriteCanvas(key, sp.color);
    if (!c) { return false; }
    ctx.drawImage(c, px, py, z, z);
    return true;
  }

  // --- things: the props, people and hostiles the mission's .amd stands here -----------

  function things() { return (S.preview && S.preview.placements) || []; }

  /** Where a thing stands right now - the drag's cell while it is being moved. */
  function thingCell(t) {
    if (S.drag && S.drag.thing === t && S.drag.patrol === null) { return S.drag.to; }
    return t.cell;
  }

  function patrolCell(t, i) {
    if (S.drag && S.drag.thing === t && S.drag.patrol === i) { return S.drag.to; }
    return [t.patrol[i].x, t.patrol[i].y];
  }

  function drawFigure(ctx, t, cell, z) {
    const sp = t.look && S.preview.sprites[t.look];
    const c = sp && spriteCanvas(t.look, t.color || sp.color);
    if (!c) { return false; }
    const [fw, fh] = sp.cells || [1, 1];
    const [ax, ay] = sp.anchor || [0.5, 1];
    const footX = (cell[0] + 0.5) * z, footY = (cell[1] + 1) * z;
    ctx.drawImage(c, footX - ax * fw * z, footY - ay * fh * z, fw * z, fh * z);
    return true;
  }

  function drawIcon(ctx, t, cell, z) {
    const cx = cell[0] * z + z / 2, cy = cell[1] * z + z / 2, r = z * 0.36;
    ctx.fillStyle = t.kind === 'prop' ? '#e8b04a' : t.calm ? '#5c5' : '#e44';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (t.kind === 'prop') { ctx.rect(cx - r, cy - r, 2 * r, 2 * r); }
    else { ctx.arc(cx, cy, r, 0, Math.PI * 2); }
    ctx.fill();
    ctx.stroke();
    if (z >= 16) {
      ctx.fillStyle = '#000';
      ctx.font = 'bold ' + Math.floor(z * 0.42) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((t.display || t.key).trim()[0].toUpperCase(), cx, cy + 1);
    }
  }

  function drawThings(ctx, z) {
    const items = things();
    // Patrol routes first, under the figures: a closed loop through each point.
    for (const t of items) {
      if (!t.patrol.length) { continue; }
      const pts = t.patrol.map((_p, i) => patrolCell(t, i));
      ctx.strokeStyle = t.key === S.sel ? '#fff' : 'rgba(255,90,90,0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      pts.forEach(([x, y], i) => { const px = x * z + z / 2, py = y * z + z / 2; if (i) { ctx.lineTo(px, py); } else { ctx.moveTo(px, py); } });
      if (pts.length > 2) { ctx.closePath(); }
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [x, y] of pts) {
        ctx.fillStyle = '#f66';
        ctx.beginPath();
        ctx.arc(x * z + z / 2, y * z + z / 2, Math.max(2, z * 0.14), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Figures in row order, so whoever stands further south is drawn over.
    const placed = items.map((t) => [t, thingCell(t)]).filter(([, c]) => c)
      .sort((a, b) => a[1][1] - b[1][1] || a[1][0] - b[1][0]);
    for (const [t, cell] of placed) {
      ctx.globalAlpha = t.hidden ? 0.45 : 1;
      if (!(S.mode === 'art' && drawFigure(ctx, t, cell, z))) { drawIcon(ctx, t, cell, z); }
      ctx.globalAlpha = 1;
      if (t.problems.length || t.key === S.sel) {
        ctx.strokeStyle = t.key === S.sel ? '#fff' : '#f33';
        ctx.lineWidth = 2;
        ctx.strokeRect(cell[0] * z + 1, cell[1] * z + 1, z - 2, z - 2);
      }
    }
  }

  /** What the Move tool would grab at a cell: a patrol point first, then a thing. */
  function grabAt(cell) {
    const [x, y] = cell;
    const items = things();
    for (let k = items.length - 1; k >= 0; k--) {
      const t = items[k];
      for (let i = 0; i < t.patrol.length; i++) {
        if (t.patrol[i].x === x && t.patrol[i].y === y && !(t.cell && t.cell[0] === x && t.cell[1] === y)) {
          return { thing: t, patrol: i };
        }
      }
    }
    for (let k = items.length - 1; k >= 0; k--) {
      const t = items[k];
      if (t.cell && t.cell[0] === x && t.cell[1] === y) { return { thing: t, patrol: null }; }
    }
    return null;
  }

  // --- marks, entry, problems (from the LIVE grid, so they follow the brush) -----------

  function marksNow() {
    const marks = {};
    const legend = {};
    for (const e of S.model.legend) { legend[e.ch] = e; }
    S.cells.forEach((row, y) => row.forEach((ch, x) => {
      const e = legend[ch];
      if (e && e.mark) { (marks[e.mark] = marks[e.mark] || []).push([x, y]); }
    }));
    return marks;
  }

  function exitTarget(mark) {
    const e = S.model.exits.find((x) => x.mark === mark);
    if (e) { return e.to; }
    return mark.startsWith('to_') ? mark.slice(3) : null;
  }

  function entryCell(marks) {
    const h = S.model.header.entry;
    if (!h) { return null; }
    const v = h.value.trim().toLowerCase();
    if (marks[v]) { return marks[v].slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])[0]; }
    const n = v.replace(/,/g, ' ').split(/\s+/).map(Number);
    return n.length >= 2 && n.every(Number.isFinite) ? [n[0], n[1]] : null;
  }

  function mapProblems() {
    S.problemCells = new Map();
    const probs = (S.preview && S.preview.problems) || [];
    for (const d of probs) {
      const c = M.cellOfLine(S.model, d.range.start.line, d.range.start.character);
      if (c) { S.problemCells.set(c.x + ',' + c.y, d.message); }
    }
  }

  // --- drawing -------------------------------------------------------------------------

  function draw() {
    const cv = $('map');
    if (!S.model) { return; }
    const z = S.zoom;
    const h = S.cells.length;
    const w = h ? S.cells[0].length : 0;
    cv.width = Math.max(1, w * z);
    cv.height = Math.max(1, h * z);
    $('empty').style.display = h ? 'none' : 'block';
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const legend = {};
    for (const e of S.model.legend) { legend[e.ch] = e; }
    const art = S.mode === 'art' && S.preview && S.preview.looks;
    const artOk = art && S.preview.looks.length === h;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ch = S.cells[y][x];
        if (ch === ' ') { continue; }
        const px = x * z, py = y * z;
        const e = legend[ch];
        if (!e) {                                  // not in the legend: the area will not load
          ctx.fillStyle = '#c0c';
          ctx.fillRect(px, py, z, z);
          continue;
        }
        const fresh = !S.dirty.has(x + ',' + y);
        const look = artOk && fresh ? S.preview.looks[y][x] : null;
        if (!(look && drawSprite(ctx, look, px, py, z))) {
          ctx.fillStyle = kindColor(e.kind);
          ctx.fillRect(px, py, z, z);
          const info = kindInfo(e.kind);
          if (S.mode === 'kinds' && info && info.walk === false) {
            ctx.fillStyle = hatchPattern(ctx);
            ctx.fillRect(px, py, z, z);
          }
        }
      }
    }
    if (artOk) {
      for (const [x, y, keys] of S.preview.fringes) {
        if (S.dirty.has(x + ',' + y) || y >= h || x >= w) { continue; }
        for (const k of keys) { drawSprite(ctx, k, x * z, y * z, z); }
      }
    }
    if (S.chars) { drawChars(ctx, legend, z); }
    if (S.grid && z >= 8) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x++) { ctx.moveTo(x * z + 0.5, 0); ctx.lineTo(x * z + 0.5, h * z); }
      for (let y = 0; y <= h; y++) { ctx.moveTo(0, y * z + 0.5); ctx.lineTo(w * z, y * z + 0.5); }
      ctx.stroke();
    }
    const marks = marksNow();
    if (S.marks) { drawMarks(ctx, marks, z); }
    if (S.things) { drawThings(ctx, z); }
    const entry = entryCell(marks);
    if (entry) { drawEntry(ctx, entry, z); }
    for (const key of S.problemCells.keys()) {
      const [x, y] = key.split(',').map(Number);
      ctx.fillStyle = '#f33';
      ctx.beginPath();
      ctx.moveTo(x * z, y * z); ctx.lineTo(x * z + z * 0.45, y * z); ctx.lineTo(x * z, y * z + z * 0.45);
      ctx.fill();
    }
    if (S.stroke && S.stroke.tool === 'rect' && S.stroke.to) {
      const [a, b] = [S.stroke.from, S.stroke.to];
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(a[0], b[0]) * z + 0.5, Math.min(a[1], b[1]) * z + 0.5,
                     (Math.abs(a[0] - b[0]) + 1) * z - 1, (Math.abs(a[1] - b[1]) + 1) * z - 1);
      ctx.setLineDash([]);
    }
    if (S.hover) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(S.hover[0] * z + 0.5, S.hover[1] * z + 0.5, z - 1, z - 1);
    }
  }

  function drawChars(ctx, legend, z) {
    ctx.font = Math.max(8, Math.floor(z * 0.55)) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    S.cells.forEach((row, y) => row.forEach((ch, x) => {
      if (ch === ' ') { return; }
      ctx.fillStyle = legend[ch] ? 'rgba(255,255,255,0.75)' : '#fff';
      ctx.fillText(ch, x * z + z / 2, y * z + z / 2 + 1);
    }));
  }

  function drawMarks(ctx, marks, z) {
    ctx.font = Math.max(9, Math.min(13, Math.floor(z * 0.42))) + 'px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (const [mark, cells] of Object.entries(marks)) {
      const target = exitTarget(mark);
      const color = target ? '#6cf' : '#fd6';
      const set = new Set(cells.map((c) => c[0] + ',' + c[1]));
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [x, y] of cells) {           // outline only the region's border
        const px = x * z, py = y * z;
        if (!set.has(x + ',' + (y - 1))) { ctx.moveTo(px, py + 1); ctx.lineTo(px + z, py + 1); }
        if (!set.has(x + ',' + (y + 1))) { ctx.moveTo(px, py + z - 1); ctx.lineTo(px + z, py + z - 1); }
        if (!set.has((x - 1) + ',' + y)) { ctx.moveTo(px + 1, py); ctx.lineTo(px + 1, py + z); }
        if (!set.has((x + 1) + ',' + y)) { ctx.moveTo(px + z - 1, py); ctx.lineTo(px + z - 1, py + z); }
      }
      ctx.stroke();
      const first = cells.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
      const label = target ? '> ' + target : '@' + mark;
      const tw = ctx.measureText(label).width + 6;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(first[0] * z, first[1] * z - 14 < 0 ? first[1] * z : first[1] * z - 14, tw, 14);
      ctx.fillStyle = color;
      ctx.fillText(label, first[0] * z + 3, (first[1] * z - 14 < 0 ? first[1] * z : first[1] * z - 14) + 1);
    }
  }

  function drawEntry(ctx, cell, z) {
    const cx = cell[0] * z + z / 2, cy = cell[1] * z + z / 2, r = z * 0.38;
    ctx.fillStyle = '#7f7';
    ctx.strokeStyle = '#030';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const rr = i % 2 ? r * 0.45 : r;
      ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // --- the palette -----------------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function renderPalette() {
    const box = $('legend');
    const items = S.model.legend.concat([{ ch: ' ', kind: 'nothing', mark: null, line: -1 }]);
    box.innerHTML = items.map((e) => {
      const info = kindInfo(e.kind);
      const rules = e.ch === ' ' ? 'never walked' : !info ? (S.preview && S.preview.tilesetFile
        ? 'NOT IN THE TILESET' : '') : (info.walk ? 'walk' : 'blocks') + (info.see ? ', see' : ', hides');
      const sw = e.ch === ' ' ? '#000' : kindColor(e.kind);
      return '<div class="entry' + (S.brush === e.ch ? ' on' : '') + (info || e.ch === ' ' || !S.preview || !S.preview.tilesetFile ? '' : ' bad')
        + '" data-ch="' + esc(e.ch) + '" title="' + esc(e.ch === ' ' ? 'Erase to nothing (also: right mouse button)' : 'Double-click to change') + '">'
        + '<span class="sw" style="background:' + sw + '"></span>'
        + '<code>' + (e.ch === ' ' ? '&nbsp;' : esc(e.ch)) + '</code>'
        + '<span class="k">' + esc(e.kind) + (e.mark ? ' <b>@' + esc(e.mark) + '</b>' : '') + '</span>'
        + '<span class="r">' + esc(rules) + '</span></div>';
    }).join('');
    const kinds = S.preview && S.preview.tilesetKinds ? Object.keys(S.preview.tilesetKinds).sort() : [];
    $('kinds').innerHTML = kinds.map((k) => '<option value="' + esc(k) + '">').join('');
  }

  $('legend').addEventListener('click', (ev) => {
    const el = ev.target.closest('.entry');
    if (!el) { return; }
    S.brush = el.dataset.ch;
    if (S.tool === 'pick' || S.tool === 'entry') { setTool('paint'); }
    keep();
    renderPalette();
    renderInfo();
  });

  $('legend').addEventListener('dblclick', (ev) => {
    const el = ev.target.closest('.entry');
    if (!el || el.dataset.ch === ' ') { return; }
    const e = legendOf(el.dataset.ch);
    openForm(e);
  });

  function openForm(e) {
    const f = $('form');
    f.style.display = 'block';
    f.dataset.editing = e ? e.ch : '';
    $('fKind').value = e ? e.kind : '';
    $('fMark').value = e && e.mark ? e.mark : '';
    $('fChar').value = e ? e.ch : '';
    $('fChar').disabled = !!e;
    $('fTitle').textContent = e ? 'Change ' + e.ch : 'New legend entry';
    $('fKind').focus();
  }

  $('addEntry').addEventListener('click', () => openForm(null));
  $('fCancel').addEventListener('click', () => { $('form').style.display = 'none'; });
  $('fKind').addEventListener('input', () => {
    if (!$('form').dataset.editing) { $('fChar').placeholder = M.freeChar(S.model, $('fKind').value) || ''; }
  });
  $('form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const kind = $('fKind').value.trim().toLowerCase();
    if (!kind) { return; }
    const mark = $('fMark').value.trim().toLowerCase().replace(/^@/, '') || null;
    const editing = $('form').dataset.editing;
    if (editing) {
      send('setLegend', { ch: editing, kind, mark });
    } else {
      let ch = $('fChar').value || M.freeChar(S.model, kind);
      ch = ch.slice(0, 1);
      if (!ch || ch === ' ' || legendOf(ch)) { $('fChar').focus(); return; }
      send('addLegend', { ch, kind, mark });
      S.brush = ch;
      keep();
    }
    $('form').style.display = 'none';
  });

  // --- info, problems, art sets ------------------------------------------------------

  function renderInfo() {
    let t = '';
    if (S.hover && S.model) {
      const [x, y] = S.hover;
      const ch = S.cells[y] && S.cells[y][x];
      const e = legendOf(ch);
      const info = e && kindInfo(e.kind);
      t = x + ', ' + y + '  ' + (ch === ' ' ? 'nothing' : e ? e.kind + (e.mark ? ' @' + e.mark : '')
        + (info ? (info.walk ? '  walk' : '  blocks') + (info.see ? ', see' : ', hides') : '')
        : JSON.stringify(ch) + ' is not in the legend');
      const p = S.problemCells.get(x + ',' + y);
      if (p) { t += '  -  ' + p; }
      for (const th of things()) {
        if (th.cell && th.cell[0] === x && th.cell[1] === y) {
          t += '  |  ' + th.display + ' (' + (th.kind === 'prop' ? 'prop' : th.calm ? 'person' : 'hostile')
            + (th.how === 'mark' ? ', Mark: ' + th.mark : '') + (th.hidden ? ', hidden' : '') + ')'
            + (th.problems.length ? ' - ' + th.problems[0] : '');
        }
      }
    }
    $('hover').textContent = t;
    const w = S.cells.length ? S.cells[0].length : 0;
    $('size').textContent = S.model ? (S.model.header.area ? S.model.header.area.value : '?') + '  '
      + w + ' x ' + S.cells.length : '';
    const p = S.preview;
    const probs = (p && p.problems) || [];
    $('problems').innerHTML = probs.map((d) => '<div class="prob ' + (d.severity === 1 ? 'err' : 'warn')
      + '" data-line="' + d.range.start.line + '">' + esc(d.message) + '</div>').join('')
      || (p ? '<div class="ok">No problems.</div>' : '');
    let sets = '';
    if (p && p.sets) {
      sets = 'Art: ' + (p.sets.map((s) => esc(s.name)).join(', ') || 'none');
      if (p.missing && p.missing.length) {
        sets += ' <span class="miss">(not found: ' + p.missing.map(esc).join(', ') + ')</span>';
      }
      if (!p.tilesetFile) {
        sets += ' <span class="miss">- no ' + esc(p.area ? p.area.tileset : '') + '.tileset, so what can be walked is unknown</span>';
      }
    }
    $('sets').innerHTML = sets;
  }

  $('problems').addEventListener('click', (ev) => {
    const el = ev.target.closest('.prob');
    if (el) { send('reveal', { line: Number(el.dataset.line) }); }
  });

  /** The sidebar list of things standing in this area - including any that are NOT on
   *  the map (a Mark: that is not there, an At: off the edge), which the canvas cannot show. */
  function renderThings() {
    const items = things();
    $('thingsHead').style.display = items.length ? '' : 'none';
    $('things').innerHTML = items.map((t) => {
      const where = t.cell ? t.cell[0] + ', ' + t.cell[1] : 'not on the map';
      const what = t.kind === 'prop' ? 'prop' : t.calm ? 'person' : 'hostile';
      return '<div class="thing' + (t.key === S.sel ? ' on' : '') + (t.problems.length ? ' bad' : '')
        + '" data-key="' + esc(t.key) + '" title="' + esc(t.problems.join('\n') || 'Click to edit in the Inspector') + '">'
        + '<span class="dot ' + what + '"></span><span class="k">' + esc(t.display) + '</span>'
        + '<span class="r">' + esc(where) + (t.hidden ? ', hidden' : '') + '</span></div>';
    }).join('');
  }

  $('things').addEventListener('click', (ev) => {
    const el = ev.target.closest('.thing');
    if (!el) { return; }
    const t = things().find((x) => x.key === el.dataset.key);
    if (!t) { return; }
    S.sel = t.key;
    renderThings();
    draw();
    send('openThing', { uri: t.uri, key: t.key });
  });

  // --- tools -------------------------------------------------------------------------

  function setTool(t) {
    S.tool = t;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    $('map').style.cursor = t === 'pick' ? 'copy' : t === 'entry' ? 'cell' : t === 'move' ? 'grab' : 'crosshair';
    keep();
  }

  function setMode(m) {
    S.mode = m;
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    keep();
    draw();
  }

  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('zin').addEventListener('click', () => zoom(1));
  $('zout').addEventListener('click', () => zoom(-1));
  $('tGrid').addEventListener('click', () => { S.grid = !S.grid; $('tGrid').classList.toggle('on', S.grid); keep(); draw(); });
  $('tMarks').addEventListener('click', () => { S.marks = !S.marks; $('tMarks').classList.toggle('on', S.marks); keep(); draw(); });
  $('tChars').addEventListener('click', () => { S.chars = !S.chars; $('tChars').classList.toggle('on', S.chars); keep(); draw(); });
  $('tThings').addEventListener('click', () => { S.things = !S.things; $('tThings').classList.toggle('on', S.things); keep(); draw(); });
  $('undoMove').addEventListener('click', () => send('undoMove'));
  $('openText').addEventListener('click', () => send('openText'));
  $('refresh').addEventListener('click', () => send('refresh'));
  $('resize').addEventListener('click', () => {
    const w = parseInt($('rw').value, 10), h = parseInt($('rh').value, 10);
    if (!(w > 0 && h > 0 && w <= 400 && h <= 400)) { return; }
    const fillCh = S.cells.length ? ' ' : (S.brush || ' ');
    S.cells = M.resize(S.cells, w, h);
    if (fillCh !== ' ') { S.cells = S.cells.map((r) => r.map(() => fillCh)); }
    // With `size`, so blank columns and rows added at the edge are kept - the text
    // trims trailing blanks, and without a size: header the map would snap back.
    send('setRows', { rows: S.cells.map((r) => r.join('')), size: [w, h] });
    draw();
  });

  const ZOOMS = [8, 12, 16, 20, 24, 28, 32, 40, 48, 64];
  function zoom(d) {
    let i = ZOOMS.findIndex((v) => v >= S.zoom);
    i = Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + d));
    S.zoom = ZOOMS[i];
    keep();
    draw();
  }

  function cellAt(ev) {
    const cv = $('map');
    const r = cv.getBoundingClientRect();
    const x = Math.floor((ev.clientX - r.left) * (cv.width / r.width) / S.zoom);
    const y = Math.floor((ev.clientY - r.top) * (cv.height / r.height) / S.zoom);
    const h = S.cells.length, w = h ? S.cells[0].length : 0;
    return x >= 0 && y >= 0 && x < w && y < h ? [x, y] : null;
  }

  function touch(x, y) { S.dirty.add(x + ',' + y); }

  function paintAt(c, ch) {
    const before = S.cells;
    S.cells = M.paint(S.cells, c[0], c[1], ch);
    if (S.cells !== before) { touch(c[0], c[1]); }
  }

  const cv = $('map');
  cv.addEventListener('contextmenu', (ev) => ev.preventDefault());
  cv.addEventListener('mousedown', (ev) => {
    const c = cellAt(ev);
    if (!c) { return; }
    ev.preventDefault();
    const erase = ev.button === 2;
    const brush = erase ? ' ' : S.brush;
    if (S.tool === 'move') {
      const g = S.things && grabAt(c);
      if (!g) { S.sel = null; renderThings(); draw(); return; }
      S.sel = g.thing.key;
      if (g.patrol === null && g.thing.how !== 'at') {
        // Placed by a mark: the mark IS the place (a scene may belong to it too), so the
        // thing moves when the mark is painted somewhere else - not from here.
        $('status').textContent = g.thing.display + ' stands on Mark: ' + g.thing.mark
          + ' - paint that mark elsewhere to move it.';
        S.drag = { thing: g.thing, patrol: null, from: c, to: c, locked: true };
      } else {
        $('status').textContent = '';
        S.drag = { thing: g.thing, patrol: g.patrol, from: c, to: c, locked: false };
      }
      renderThings();
      draw();
      return;
    }
    if (S.tool === 'pick' || ev.altKey) {
      S.brush = S.cells[c[1]][c[0]];
      keep();
      renderPalette();
      return;
    }
    if (S.tool === 'entry') {
      send('setEntry', { value: c[0] + ', ' + c[1] });
      return;
    }
    if (S.tool === 'fill') {
      const before = S.cells;
      S.cells = M.fill(S.cells, c[0], c[1], brush);
      S.cells.forEach((row, y) => row.forEach((ch, x) => { if (before[y][x] !== ch) { touch(x, y); } }));
      if (S.cells !== before) { commit(); }
      draw();
      return;
    }
    S.stroke = { tool: S.tool, from: c, to: c, last: c, brush, start: S.cells };
    if (S.tool === 'paint') { paintAt(c, brush); }
    draw();
  });

  window.addEventListener('mousemove', (ev) => {
    const c = cellAt(ev);
    const moved = (c && S.hover ? c[0] !== S.hover[0] || c[1] !== S.hover[1] : c !== S.hover);
    S.hover = c;
    if (S.drag && c && !S.drag.locked) { S.drag.to = c; }
    if (S.stroke && c) {
      if (S.stroke.tool === 'paint') {
        for (const p of M.line(S.stroke.last[0], S.stroke.last[1], c[0], c[1])) { paintAt(p, S.stroke.brush); }
        S.stroke.last = c;
      } else if (S.stroke.tool === 'rect') {
        S.stroke.to = c;
      }
    }
    if (moved || S.stroke || S.drag) { renderInfo(); draw(); }
  });

  function dropThing() {
    const d = S.drag;
    S.drag = null;
    const t = d.thing;
    const same = d.to[0] === d.from[0] && d.to[1] === d.from[1];
    if (same) {                                   // a click, not a drag: edit it
      send('openThing', { uri: t.uri, key: t.key });
      draw();
      return;
    }
    // Write the new cell where the old one is written: `At: x, y`, or one point of a
    // `Patrol: x y; x y` in that list's own style. Optimistically show it there until
    // the language server answers with the .amd as it now reads.
    if (d.patrol === null) {
      send('moveThing', { uri: t.uri, line: t.at.line, start: t.at.start, end: t.at.end,
                          from: d.from, text: d.to[0] + ', ' + d.to[1] });
      t.cell = d.to.slice();
    } else {
      const p = t.patrol[d.patrol];
      send('moveThing', { uri: t.uri, line: p.line, start: p.start, end: p.end,
                          from: d.from, text: d.to[0] + ' ' + d.to[1] });
      p.x = d.to[0];
      p.y = d.to[1];
    }
    draw();
  }

  window.addEventListener('mouseup', (ev) => {
    if (S.drag) { dropThing(); return; }
    const st = S.stroke;
    if (!st) { return; }
    S.stroke = null;
    if (st.tool === 'rect') {
      const before = S.cells;
      S.cells = M.rect(S.cells, st.from[0], st.from[1], st.to[0], st.to[1], st.brush, ev.shiftKey);
      S.cells.forEach((row, y) => row.forEach((ch, x) => { if (before[y][x] !== ch) { touch(x, y); } }));
    }
    if (S.cells !== st.start) { commit(); }
    if (S.pendingText !== null) { const t = S.pendingText; S.pendingText = null; loadText(t); }
    draw();
  });

  cv.addEventListener('mouseleave', () => { S.hover = null; renderInfo(); draw(); });
  $('scroll').addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey) { return; }
    ev.preventDefault();
    zoom(ev.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  window.addEventListener('keydown', (ev) => {
    if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) { return; }
    const k = ev.key.toLowerCase();
    if (ev.ctrlKey || ev.metaKey || ev.altKey) { return; }
    if (k === 'b') { setTool('paint'); }
    else if (k === 'r') { setTool('rect'); }
    else if (k === 'f') { setTool('fill'); }
    else if (k === 'i') { setTool('pick'); }
    else if (k === 'e') { setTool('entry'); }
    else if (k === 'm') { setTool('move'); }
    else if (k === 'a') { setMode(S.mode === 'art' ? 'kinds' : 'art'); }
    else if (k === '+' || k === '=') { zoom(1); }
    else if (k === '-') { zoom(-1); }
  });

  // --- from the extension --------------------------------------------------------------

  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'doc') {
      if (S.stroke) { S.pendingText = msg.text; return; }   // never drop a stroke in flight
      loadText(msg.text);
    } else if (msg.type === 'preview') {
      S.preview = msg.data;
      S.sheets = msg.sheets || {};
      // The answer is for the text it was asked about; cells painted since stay dirty.
      S.dirty = new Set();
      if (msg.text !== undefined && msg.text !== S.text) {
        const now = M.grid(M.parse(msg.text));
        S.cells.forEach((row, y) => row.forEach((ch, x) => {
          if (!now[y] || now[y][x] !== ch) { S.dirty.add(x + ',' + y); }
        }));
      }
      $('status').textContent = msg.data && msg.data.ok ? '' : (msg.data && msg.data.error) || '';
      mapProblems();
      renderPalette();
      renderInfo();
      renderThings();
      draw();
    } else if (msg.type === 'status') {
      $('status').textContent = msg.text || '';
    } else if (msg.type === 'moves') {
      $('undoMove').style.display = msg.count ? '' : 'none';
      $('undoMove').textContent = 'Undo move' + (msg.count > 1 ? ' (' + msg.count + ')' : '');
    }
  });

  setTool(S.tool);
  setMode(S.mode);
  $('tGrid').classList.toggle('on', S.grid);
  $('tMarks').classList.toggle('on', S.marks);
  $('tChars').classList.toggle('on', S.chars);
  $('tThings').classList.toggle('on', S.things);
  send('ready');
})();
