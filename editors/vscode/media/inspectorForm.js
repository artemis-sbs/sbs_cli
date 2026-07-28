// Shared Inspector form — one implementation mounted in every surface: the
// movable panel, the docked view, and the map/graph drawer. It builds the form
// DOM in a host-provided container and talks to the extension over a message
// `prefix` so several forms can share one webview (the map/graph drawer uses
// "insp:"; the standalone webviews use "").
//
//   const h = InspectorForm.mount(container, vscode, { prefix, model, faceAvailable });
//   h.render(model)  — full rebuild (the shown node changed)
//   h.patch(m)       — update values for {display,fields,body}, skipping the field
//                      the user is editing (reverse sync)
//   h.setFace(value) — drop a face string into the Face field and re-apply
//
// It posts:  {type: prefix+'applyNode', display, fields, body}   (debounced)
//            {type: prefix+'buildFace', face}
//            {type: prefix+'faceEditor', face}
// Face preview uses window.FaceRender (face.js) when present.
//
// WIDGETS ARE SCHEMA-DRIVEN. Each field carries a `schema` descriptor (from the
// LSP, sourced from sbs_utils.procedural.amd_schema): enum -> dropdown, ref ->
// combobox against the mission symbol table, coord2 -> two cells, color ->
// swatch, signal -> combobox, compound (When/Then) -> verb + typed operand, face
// -> the Face Builder. `model.options` holds the candidate lists (node/side/
// signal). A field with no schema (a hand-added row) degrades to a text box.
(function (global) {
  'use strict';

  let _mountSeq = 0;

  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // '#07F' / '#0077FF' -> '#0077ff' for <input type=color>; null if not a hex.
  function expandHex(v) {
    const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(v || '').trim());
    if (!m) { return null; }
    let h = m[1];
    if (h.length === 3) { h = h.split('').map((c) => c + c).join(''); }
    return '#' + h.toLowerCase();
  }

  // 'i, j' (or 'i j') -> ['i','j']; missing parts come back ''.
  function coordParts(v) {
    const t = String(v || '').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    return [t[0] || '', t[1] || ''];
  }

  // 'verb rest...' -> [verb, operand]; verb only counts if it's in the schema's
  // verb set, else the whole value is the operand under the first verb.
  function compoundParts(v, verbs) {
    const s = String(v || '').trim();
    const sp = s.indexOf(' ');
    const head = sp < 0 ? s : s.slice(0, sp);
    if (head && verbs[head.toLowerCase()]) {
      return [head.toLowerCase(), sp < 0 ? '' : s.slice(sp + 1).trim()];
    }
    const first = Object.keys(verbs)[0] || '';
    return [first, s];
  }

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) { return; }
    stylesInjected = true;
    const s = document.createElement('style');
    s.textContent = `
      .insp-root { padding: 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
      .insp-root h3 { margin: 0 0 10px; font-size: 1.1em; }
      .insp-root h4 { margin: 14px 0 6px; color: var(--vscode-descriptionForeground); font-weight: 600; }
      .insp-root .k { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
      .insp-root input, .insp-root textarea, .insp-root select { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #8884); border-radius: 3px; padding: 4px 6px; font-family: inherit; }
      .insp-root select { background: var(--vscode-dropdown-background, var(--vscode-input-background)); }
      .insp-root textarea { font-family: var(--vscode-editor-font-family, monospace); }
      .insp-root .frow { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
      .insp-root .frow .flabel { flex: 0 0 30%; } .insp-root .frow .fval { flex: 1 1 auto; }
      .insp-root .frow .arch { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: 10px; }
      .insp-root .fcoord { flex: 1 1 auto; display: flex; gap: 4px; } .insp-root .fcoord input { width: 50%; }
      .insp-root .fcolor { flex: 1 1 auto; display: flex; gap: 4px; align-items: center; }
      .insp-root .fcolor input[type=color] { flex: 0 0 28px; width: 28px; height: 26px; padding: 0; }
      .insp-root .fcompound { flex: 1 1 auto; display: flex; gap: 4px; } .insp-root .fverb { flex: 0 0 38%; }
      .insp-root button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 5px 12px; cursor: pointer; margin-top: 10px; }
      .insp-root button:hover { background: var(--vscode-button-hoverBackground); }
      .insp-root .sec { color: var(--vscode-descriptionForeground); font-size: 11px; }
      .insp-root .insp-addf, .insp-root .facebtn { background: var(--vscode-button-secondaryBackground, #444); color: var(--vscode-button-secondaryForeground, #fff); padding: 2px 8px; }
      .insp-root .facebtn { flex: 0 0 auto; margin: 0; }
      .insp-root .insp-face { display: block; width: 110px; height: 110px; margin: 6px 0; border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px; background: var(--vscode-input-background); cursor: pointer; }
      .insp-root .insp-face:hover { border-color: var(--vscode-focusBorder, #58f); }`;
    document.head.appendChild(s);
  }

  function mount(container, vscode, opts) {
    injectStyles();
    const prefix = (opts && opts.prefix) || '';
    let model = normalizeModel((opts && opts.model) || {});
    let applyTimer = 0;
    const uid = 'if' + (++_mountSeq);          // unique datalist-id namespace

    function normalizeModel(m) {
      return {
        key: m.key || '', display: m.display || '',
        fields: m.fields || [], body: m.body || '',
        options: m.options || {},
        kind: m.kind || '', kinds: m.kinds || [], archetype: m.archetype || '',
      };
    }

    // What the record CALLS itself. Not decoration: `Beat` decides that it is the
    // crew's, already running, and listed only once it has happened - so the row shows
    // what the chosen word implies rather than leaving it to be read in the docs.
    function kindRow() {
      const kinds = model.kinds || [];
      if (!kinds.length) { return ''; }
      const cur = String(model.kind || '').toLowerCase();
      // Grouped - Story / Work / Content - because a flat list of every noun reads as a
      // wall rather than a choice. (The reader still ACCEPTS every plural and alias.)
      const groups = [];
      for (const k of kinds) {
        const g = k.group || '';
        const last = groups[groups.length - 1];
        if (!last || last.name !== g) { groups.push({ name: g, items: [k] }); }
        else { last.items.push(k); }
      }
      const opt = (k) => `<option value="${esc(k.noun)}"${k.noun.toLowerCase() === cur ? ' selected' : ''}>` +
                         `${esc(k.noun)}</option>`;
      // Name what it resolved to. "(from the section name)" told an author the word came
      // from somewhere else without saying what it landed on.
      const inherited = String(model.archetype || '');
      // Say which of the two it is. "(from the section name)" was told to records where
      // NOTHING resolved - the section did not say, so the record has no type at all and
      // gets no typed fields, no lint and no help until someone picks one.
      const none = inherited
        ? `(from the section: ${esc(inherited[0].toUpperCase() + inherited.slice(1))})`
        : '(no type yet - pick one)';
      const opts = [`<option value="">${none}</option>`].concat(
        groups.map((g) => g.name
          ? `<optgroup label="${esc(g.name)}">${g.items.map(opt).join('')}</optgroup>`
          : g.items.map(opt).join(''))).join('');
      const hit = kinds.find((k) => k.noun.toLowerCase() === cur);
      const implies = hit && hit.implies ? `<div class="sec insp-kind-implies">means ${esc(hit.implies)}</div>` : '';
      return `<label class="k">This is a</label><select class="insp-kind">${opts}</select>${implies}`;
    }

    const q = (sel) => container.querySelector(sel);
    const faceCanvas = () => q('.insp-face');
    function drawFace(str) {
      const c = faceCanvas();
      if (c && global.FaceRender) { global.FaceRender.drawString(c, c.getContext('2d'), str); }
    }

    function optionList(kind) {
      const o = model.options || {};
      return (kind === 'side' ? (o.side || o.node) : kind === 'signal' ? o.signal : o.node) || [];
    }
    function datalistId(kind) { return uid + '-' + kind; }
    function sharedDatalists() {
      // node/side/signal candidate lists, shared by every combobox in this form.
      return ['node', 'side', 'signal'].map((k) =>
        `<datalist id="${datalistId(k)}">${optionList(k).map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`
      ).join('');
    }

    // The control(s) after the `label :` for one field, chosen by schema.type.
    function fieldControl(sch, value) {
      const t = (sch && sch.type) || 'text';
      const hint = sch && sch.hint ? ` placeholder="${esc(sch.hint)}"` : ' placeholder="value"';
      switch (t) {
        case 'multiline':
          return `<textarea class="fval" rows="2"${hint}>${esc(value)}</textarea>`;
        case 'int':
          return `<input class="fval" inputmode="numeric"${hint} value="${esc(value)}"/>`;
        case 'enum': {
          const vals = (sch.values || []).slice();
          if (sch.open) {                       // suggestions, free text allowed
            const dl = uid + '-e-' + Math.random().toString(36).slice(2, 7);
            return `<input class="fval" list="${dl}" value="${esc(value)}"${hint}/>` +
                   `<datalist id="${dl}">${vals.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>`;
          }
          if (value && vals.indexOf(value) < 0) { vals.push(value); }   // keep an odd stored value
          return `<select class="fval">${vals.map((o) => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
        }
        case 'ref': {
          // node/side refs pick from the mission symbol table; a csv ref is a free
          // comma list but still suggests node keys.
          const list = datalistId(sch.ref === 'side' ? 'side' : 'node');
          return `<input class="fval" list="${list}" value="${esc(value)}"${hint}/>`;
        }
        case 'signal':
          return `<input class="fval" list="${datalistId('signal')}" value="${esc(value)}" placeholder="signal name"/>`;
        case 'color': {
          const hx = expandHex(value) || '#888888';
          return `<span class="fcolor"><input class="fval" value="${esc(value)}"${hint}/>` +
                 `<input type="color" class="fswatch" value="${hx}"/></span>`;
        }
        case 'coord2': {
          const [i, j] = coordParts(value);
          return `<span class="fcoord"><input class="fc-i" inputmode="numeric" placeholder="i" value="${esc(i)}"/>` +
                 `<input class="fc-j" inputmode="numeric" placeholder="j" value="${esc(j)}"/></span>`;
        }
        case 'compound': {
          const verbs = sch.verbs || {};
          const [verb, operand] = compoundParts(value, verbs);
          const opts = Object.keys(verbs).map((v) => `<option${v === verb ? ' selected' : ''}>${esc(v)}</option>`).join('');
          const operSch = verbs[verb] || { type: 'text' };
          return `<span class="fcompound"><select class="fverb">${opts}</select>` +
                 `<span class="foperand">${fieldControl(operSch, operand)}</span></span>`;
        }
        case 'face':
          return `<input class="fval facefield" value="${esc(value)}" placeholder="face string or female/male"/><button type="button" class="facebtn">Face…</button>`;
        default:              // text / csv / role / unknown
          return `<input class="fval" value="${esc(value)}"${hint}/>`;
      }
    }

    function build() {
      container.className = 'insp-root';
      const rows = model.fields.map((f) => {
        const sch = f.schema || { type: 'text' };
        return `<div class="frow" data-ftype="${esc(sch.type || 'text')}">` +
               `<input class="flabel" value="${esc(f.label)}" placeholder="field"/><span>:</span>` +
               fieldControl(sch, f.value) + `</div>`;
      }).join('');
      const hasFace = model.fields.some((f) => (f.schema && f.schema.type) === 'face' ||
                                               String(f.label).toLowerCase() === 'face');
      container.innerHTML =
        `<h3>${esc(model.display || model.key)} <span class="sec">(${esc(model.key)})</span></h3>` +
        `<label class="k">Display</label><input class="insp-display" value="${esc(model.display)}"/>` +
        kindRow() +
        `<h4>Fields</h4><div class="insp-fields">${rows}</div>` +
        (hasFace ? '<canvas class="insp-face" width="220" height="220" title="Click to edit in the Face Builder"></canvas>' : '') +
        `<button class="insp-addf">+ add field</button>` +
        `<h4>Body</h4><textarea class="insp-body" rows="14">${esc(model.body)}</textarea>` +
        `<div class="sec insp-status">Changes apply automatically.</div>` +
        sharedDatalists();
      // Stamp each row with its schema so collect()/patch() know how to (de)serialize.
      const rowEls = [...container.querySelectorAll('.frow')];
      model.fields.forEach((f, i) => { if (rowEls[i]) { rowEls[i].__schema = f.schema || { type: 'text' }; } });
      wire();
      const ff = q('.facefield');
      drawFace(ff ? ff.value : '');
    }

    // Serialize one row's widget(s) back to a single string value.
    function rowValue(row) {
      const ftype = row.dataset.ftype || 'text';
      if (ftype === 'coord2') {
        const i = row.querySelector('.fc-i'), j = row.querySelector('.fc-j');
        const a = (i && i.value.trim()) || '', b = (j && j.value.trim()) || '';
        return (a || b) ? (a + ', ' + b) : '';
      }
      if (ftype === 'compound') {
        const verb = (row.querySelector('.fverb') || {}).value || '';
        const oper = readValueControl(row.querySelector('.foperand'));
        return (verb + ' ' + oper).trim();
      }
      const el = row.querySelector('.fval');
      return el ? el.value.trim() : '';
    }
    // The value of a single-control container (compound operand may itself be a coord).
    function readValueControl(span) {
      if (!span) { return ''; }
      const i = span.querySelector('.fc-i'), j = span.querySelector('.fc-j');
      if (i || j) {
        const a = (i && i.value.trim()) || '', b = (j && j.value.trim()) || '';
        return (a || b) ? (a + ', ' + b) : '';
      }
      const el = span.querySelector('.fval');
      return el ? el.value.trim() : '';
    }

    function collect() {
      const fields = [...container.querySelectorAll('.frow')].map((r) => ({
        label: r.querySelector('.flabel').value.trim(), value: rowValue(r),
      })).filter((f) => f.label);
      const kindSel = q('.insp-kind');
      return { display: q('.insp-display').value, fields, body: q('.insp-body').value,
               kind: kindSel ? kindSel.value : undefined };
    }
    function scheduleApply() {
      const st = q('.insp-status'); if (st) { st.textContent = 'Editing…'; }
      clearTimeout(applyTimer);
      applyTimer = setTimeout(() => {
        if (st) { st.textContent = 'Saved'; }
        vscode.postMessage(Object.assign({ type: prefix + 'applyNode' }, collect()));
      }, 300);
    }

    let wired = false;
    function wire() {
      if (!wired) {
        // Delegated once on the container — survives innerHTML rebuilds.
        container.addEventListener('input', onInput);
        container.addEventListener('change', onChange);
        container.addEventListener('click', onClick);
        wired = true;
      }
    }
    function onInput(e) {
      const t = e.target;
      if (t && t.classList && t.classList.contains('facefield')) { drawFace(t.value); }
      scheduleApply();
    }
    function onChange(e) {
      const t = e.target;
      // A colour-swatch change writes the hex back into the row's text field.
      if (t && t.classList && t.classList.contains('fswatch')) {
        const tf = t.parentElement.querySelector('.fval');
        if (tf) { tf.value = t.value; }
      }
      // Switching a compound verb re-renders its operand control to the verb's type.
      if (t && t.classList && t.classList.contains('fverb')) { rebuildOperand(t); }
      scheduleApply();
    }
    function rebuildOperand(verbSel) {
      const row = verbSel.closest('.frow');
      const sch = row && row.__schema;
      if (!sch || sch.type !== 'compound') { return; }
      const operSch = (sch.verbs || {})[verbSel.value] || { type: 'text' };
      const span = row.querySelector('.foperand');
      if (span) { span.innerHTML = fieldControl(operSch, ''); }
    }
    function onClick(e) {
      const t = e.target;
      if (!t || !t.classList) { return; }
      if (t.classList.contains('insp-addf')) {
        const div = document.createElement('div'); div.className = 'frow'; div.dataset.ftype = 'text';
        div.__schema = { type: 'text' };
        div.innerHTML = '<input class="flabel" placeholder="field"/><span>:</span><input class="fval" placeholder="value"/>';
        q('.insp-fields').appendChild(div);
        div.querySelector('.flabel').focus();
      } else if (t.classList.contains('facebtn')) {
        const ff = q('.facefield');
        vscode.postMessage({ type: prefix + 'buildFace', face: ff ? ff.value : '' });
      } else if (t.classList.contains('insp-face')) {
        // Click the face preview -> jump straight into the Build custom editor.
        const ff = q('.facefield');
        vscode.postMessage({ type: prefix + 'faceEditor', face: ff ? ff.value : '' });
      }
    }

    function render(m) { model = normalizeModel(m || model); build(); }

    // Reverse sync: mirror external edits into fields the user isn't focused in.
    function setRowValue(row, value) {
      const ftype = row.dataset.ftype || 'text';
      if (ftype === 'coord2') {
        const [i, j] = coordParts(value);
        const ei = row.querySelector('.fc-i'), ej = row.querySelector('.fc-j');
        if (ei) { ei.value = i; } if (ej) { ej.value = j; }
        return;
      }
      if (ftype === 'compound') {
        const sch = row.__schema || { verbs: {} };
        const [verb, operand] = compoundParts(value, sch.verbs || {});
        const vs = row.querySelector('.fverb'); if (vs) { vs.value = verb; }
        const span = row.querySelector('.foperand');
        if (span) { const el = span.querySelector('.fval') || span.querySelector('.fc-i'); if (el && el.classList.contains('fval')) { el.value = operand; } }
        return;
      }
      const el = row.querySelector('.fval');
      if (el) { el.value = value; }
      if (ftype === 'color') { const sw = row.querySelector('.fswatch'); const hx = expandHex(value); if (sw && hx) { sw.value = hx; } }
    }
    function patch(m) {
      const active = document.activeElement;
      const setIf = (el, val) => { if (el && el !== active && el.value !== val) { el.value = val; } };
      setIf(q('.insp-display'), m.display);
      setIf(q('.insp-body'), m.body);
      const rows = [...container.querySelectorAll('.frow')];
      for (const f of (m.fields || [])) {
        const row = rows.find((r) => r.querySelector('.flabel').value.trim().toLowerCase() === String(f.label).toLowerCase());
        if (row && !row.contains(active)) { setRowValue(row, f.value); }
      }
      const ff = q('.facefield'); if (ff) { drawFace(ff.value); }
      const st = q('.insp-status'); if (st) { st.textContent = 'Saved'; }
    }
    function setFace(value) {
      const ff = q('.facefield'); if (ff) { ff.value = value; }
      drawFace(value);
      scheduleApply();
    }

    build();
    return { render, patch, setFace };
  }

  global.InspectorForm = { mount };
})(typeof window !== 'undefined' ? window : this);
