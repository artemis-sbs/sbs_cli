// Tileset Editor - the webview half. A table of a .tileset file's kinds: the rules each
// one has (walk, see, tall), the ground look an art set draws it with, a tint, and how
// many cells of the mission's areas use it.
//
// The DOCUMENT is the source of truth: the table is re-read from the text (TilesetModel)
// on every change, and each edit goes to the extension, which rewrites that ONE line.
// What the art sets offer, and what each look looks like, come from the language server
// (`tiles/tilesetPreview`).
/* global TilesetModel, acquireVsCodeApi */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const TM = TilesetModel;
  const $ = (id) => document.getElementById(id);
  const S = { model: null, preview: null, sheets: {}, images: {}, cut: {}, sel: null, armed: null };

  function send(type, data) { vscode.postMessage(Object.assign({ type }, data || {})); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  // --- art ------------------------------------------------------------------------------

  function image(uri) {
    if (!S.images[uri]) {
      const img = new Image();
      img.onload = () => paintSwatches();
      img.src = uri;
      S.images[uri] = img;
    }
    return S.images[uri];
  }

  /** A sprite cut from its sheet and tinted (multiply, alpha kept), or null. */
  function sprite(key, color) {
    const sp = S.preview && S.preview.sprites && S.preview.sprites[key];
    const uri = sp && S.sheets[sp.sheet];
    if (!uri) { return null; }
    const img = image(uri);
    if (!img.complete || !img.naturalWidth) { return null; }
    const id = key + '|' + (color || '');
    if (S.cut[id]) { return S.cut[id]; }
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
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(img, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
    }
    S.cut[id] = c;
    return c;
  }

  function paintSwatches() {
    document.querySelectorAll('canvas[data-key]').forEach((cv) => {
      const g = cv.getContext('2d');
      g.clearRect(0, 0, cv.width, cv.height);
      const c = cv.dataset.key && sprite(cv.dataset.key, cv.dataset.color || null);
      if (c) { g.drawImage(c, 0, 0, cv.width, cv.height); }
      else {
        g.fillStyle = cv.dataset.color || '#333';
        g.fillRect(0, 0, cv.width, cv.height);
        if (!cv.dataset.key) {
          g.strokeStyle = '#c33';
          g.beginPath(); g.moveTo(0, 0); g.lineTo(cv.width, cv.height); g.stroke();
        }
      }
    });
  }

  // --- the table --------------------------------------------------------------------------

  function render() {
    if (!S.model) { return; }
    const p = S.preview || {};
    const art = p.art || {};
    const usage = p.usage || {};
    const looks = Object.keys(p.looks || {});
    $('looks').innerHTML = looks.map((l) => '<option value="' + esc(l) + '">').join('');
    if (document.activeElement !== $('hName')) { $('hName').value = (S.model.header.tileset || {}).value || ''; }
    if (document.activeElement !== $('hTitle')) { $('hTitle').value = (S.model.header.title || {}).value || ''; }
    const body = S.model.kinds.map((k) => {
      const r = k.rules;
      const used = usage[k.name] || 0;
      const key = art[k.name];
      const look = r.look || k.name;
      const lookInfo = (p.looks || {})[look];
      const noArt = p.looks && !lookInfo && !r.cell;
      return '<tr data-name="' + esc(k.name) + '"' + (S.sel === k.name ? ' class="on"' : '') + '>'
        + '<td><canvas width="28" height="28" data-key="' + esc(key || '') + '" data-color="' + esc(r.color || '') + '"></canvas></td>'
        + '<td><input class="name" value="' + esc(k.name) + '" spellcheck="false"></td>'
        + ['walk', 'see', 'tall'].map((f) => '<td class="c"><input type="checkbox" data-f="' + f + '"' + (r[f] ? ' checked' : '') + '></td>').join('')
        + '<td><input data-f="look" list="looks" value="' + esc(r.look || '') + '" placeholder="' + esc(k.name) + '"'
        + (noArt ? ' class="bad" title="No art set draws a look called ' + esc(look) + '"' : '') + '></td>'
        + '<td><input data-f="color" size="7" value="' + esc(r.color || '') + '" placeholder="#rgb"></td>'
        + '<td><input data-f="over" type="number" style="width:4em" value="' + esc(r.over != null && Number.isFinite(r.over) ? r.over : '') + '"></td>'
        + '<td class="n' + (used ? '' : ' unused') + '">' + (p.usage ? used : '') + '</td>'
        + '<td><button class="del" title="Remove this kind">' + (S.armed === k.name ? 'Sure?' : 'x') + '</button></td>'
        + '</tr>';
    }).join('');
    $('rows').innerHTML = body;
    const probs = (p.problems || []).map((d) => '<div class="prob ' + (d.severity === 1 ? 'err' : 'warn')
      + '" data-line="' + d.range.start.line + '">' + esc(d.message) + '</div>');
    for (const e of S.model.errors) { probs.push('<div class="prob err" data-line="' + e.line + '">' + esc(e.message) + '</div>'); }
    $('problems').innerHTML = probs.join('') || (p.ok !== undefined ? '<div class="ok">No problems.</div>' : '');
    let foot = '';
    if (p.sets) {
      foot = 'Art: ' + (p.sets.map((s) => esc(s.name)).join(', ') || 'none');
      if (p.missing && p.missing.length) { foot += ' <span class="miss">(not found: ' + p.missing.map(esc).join(', ') + ')</span>'; }
      if (p.areas) { foot += ' &nbsp; Used by: ' + (p.areas.map(esc).join(', ') || '<span class="miss">no area</span>'); }
    }
    $('foot').innerHTML = foot;
    $('gallery').innerHTML = looks.map((l) => {
      const info = p.looks[l];
      return '<div class="look" data-look="' + esc(l) + '" title="' + esc(l)
        + (info.tall ? ' - tall' : '') + (info.fringe ? ' - frays onto its neighbors' : '')
        + (info.edges ? ' - has edge pieces' : '') + '"><canvas width="36" height="36" data-key="'
        + esc(info.key || '') + '"></canvas><span>' + esc(l) + '</span></div>';
    }).join('');
    paintSwatches();
  }

  function rulesOf(tr) {
    const k = S.model.kinds.find((x) => x.name === tr.dataset.name);
    const r = Object.assign({}, k ? k.rules : {});
    tr.querySelectorAll('[data-f]').forEach((el) => {
      const f = el.dataset.f;
      if (el.type === 'checkbox') { r[f] = el.checked; }
      else if (f === 'over') { r[f] = el.value === '' ? undefined : Number(el.value); }
      else { r[f] = el.value.trim() || undefined; }
    });
    return r;
  }

  $('rows').addEventListener('change', (ev) => {
    const tr = ev.target.closest('tr');
    if (!tr) { return; }
    const oldName = tr.dataset.name;
    const name = tr.querySelector('.name').value.trim().toLowerCase();
    if (!/^[\w-]+$/.test(name)) { $('status').textContent = 'A kind name is one word: letters, digits, _ or -.'; render(); return; }
    if (name !== oldName && S.model.kinds.some((k) => k.name === name)) {
      $('status').textContent = 'There is already a kind called ' + name + '.';
      render();
      return;
    }
    const used = ((S.preview || {}).usage || {})[oldName] || 0;
    $('status').textContent = name !== oldName && used
      ? 'Renamed - the ' + used + ' cells the areas draw as ' + oldName + ' still say ' + oldName + ' in their legends.'
      : '';
    S.sel = name;
    send('setKind', { oldName, name, rules: rulesOf(tr) });
  });

  $('rows').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr');
    if (!tr) { return; }
    const name = tr.dataset.name;
    if (ev.target.classList.contains('del')) {
      const used = ((S.preview || {}).usage || {})[name] || 0;
      if (used && S.armed !== name) {           // two clicks to remove a kind in use
        S.armed = name;
        $('status').textContent = name + ' is drawn on ' + used + ' cells - click again to remove it anyway.';
        render();
        return;
      }
      S.armed = null;
      send('removeKind', { name });
      return;
    }
    if (S.sel !== name) { S.sel = name; S.armed = null; render(); }
  });

  // A look in the gallery goes onto the selected kind.
  $('gallery').addEventListener('click', (ev) => {
    const el = ev.target.closest('.look');
    if (!el || !S.sel) {
      if (el) { $('status').textContent = 'Select a kind first, then pick its look.'; }
      return;
    }
    const k = S.model.kinds.find((x) => x.name === S.sel);
    if (!k) { return; }
    send('setKind', { oldName: k.name, name: k.name, rules: Object.assign({}, k.rules, { look: el.dataset.look }) });
  });

  $('addKind').addEventListener('click', () => {
    const name = $('newName').value.trim().toLowerCase();
    if (!/^[\w-]+$/.test(name) || S.model.kinds.some((k) => k.name === name)) {
      $('status').textContent = name ? 'That name is taken or is not one word.' : 'Type the new kind\'s name first.';
      $('newName').focus();
      return;
    }
    // Walkable ground by default; with no look= it wears the look of its own name.
    send('addKind', { name, rules: { walk: true, see: true } });
    S.sel = name;
    $('newName').value = '';
  });
  $('newName').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { $('addKind').click(); } });

  for (const [id, key] of [['hName', 'tileset'], ['hTitle', 'title']]) {
    $(id).addEventListener('change', () => { const v = $(id).value.trim(); if (v) { send('setHeader', { key, value: v }); } });
  }
  $('problems').addEventListener('click', (ev) => {
    const el = ev.target.closest('.prob');
    if (el) { send('reveal', { line: Number(el.dataset.line) }); }
  });
  $('refresh').addEventListener('click', () => send('refresh'));
  $('openText').addEventListener('click', () => send('openText'));

  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'doc') {
      S.model = TM.parse(msg.text);
      render();
    } else if (msg.type === 'preview') {
      S.preview = msg.data;
      S.sheets = msg.sheets || {};
      S.cut = {};
      render();
    } else if (msg.type === 'status') {
      $('status').textContent = msg.text || '';
    }
  });

  send('ready');
})();
