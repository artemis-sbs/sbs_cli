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
// Face preview uses window.FaceRender (face.js) when present.
(function (global) {
  'use strict';

  const FIELD_ENUMS = {
    state: ['active', 'secret', 'idle', 'complete', 'failed'],
    scope: ['shared', 'ship'],
    kind: ['derelict', 'station', 'worldlet'],
    mode: ['story', 'sandbox', 'skirmish', 'war', 'campaign'],
    win: ['true', 'false'],
    lose: ['true', 'false'],
  };

  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
      .insp-root .frow .flabel { flex: 0 0 34%; } .insp-root .frow .fval { flex: 1 1 auto; }
      .insp-root button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 5px 12px; cursor: pointer; margin-top: 10px; }
      .insp-root button:hover { background: var(--vscode-button-hoverBackground); }
      .insp-root .sec { color: var(--vscode-descriptionForeground); font-size: 11px; }
      .insp-root .insp-addf, .insp-root .facebtn { background: var(--vscode-button-secondaryBackground, #444); color: var(--vscode-button-secondaryForeground, #fff); padding: 2px 8px; }
      .insp-root .facebtn { flex: 0 0 auto; margin: 0; }
      .insp-root .insp-face { display: block; width: 110px; height: 110px; margin: 6px 0; border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px; background: var(--vscode-input-background); }`;
    document.head.appendChild(s);
  }

  function mount(container, vscode, opts) {
    injectStyles();
    const prefix = (opts && opts.prefix) || '';
    let model = (opts && opts.model) || { key: '', display: '', fields: [], body: '' };
    let applyTimer = 0;

    const q = (sel) => container.querySelector(sel);
    const faceCanvas = () => q('.insp-face');
    function drawFace(str) {
      const c = faceCanvas();
      if (c && global.FaceRender) { global.FaceRender.drawString(c, c.getContext('2d'), str); }
    }

    function build() {
      container.className = 'insp-root';
      const rows = model.fields.map((f) => {
        if (String(f.label).toLowerCase() === 'face') {
          return `<div class="frow"><input class="flabel" value="${esc(f.label)}"/><span>:</span><input class="fval facefield" value="${esc(f.value)}" placeholder="face string or female/male"/><button type="button" class="facebtn">Face…</button></div>`;
        }
        const opts2 = FIELD_ENUMS[String(f.label).toLowerCase()];
        let ctrl;
        if (opts2) {
          const all = opts2.slice();
          if (f.value && all.indexOf(f.value) < 0) { all.push(f.value); }
          ctrl = `<select class="fval">${all.map((o) => `<option${o === f.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
        } else {
          ctrl = `<input class="fval" value="${esc(f.value)}" placeholder="value"/>`;
        }
        return `<div class="frow"><input class="flabel" value="${esc(f.label)}" placeholder="field"/><span>:</span>${ctrl}</div>`;
      }).join('');
      const hasFace = model.fields.some((f) => String(f.label).toLowerCase() === 'face');
      container.innerHTML =
        `<h3>${esc(model.display || model.key)} <span class="sec">(${esc(model.key)})</span></h3>` +
        `<label class="k">Display</label><input class="insp-display" value="${esc(model.display)}"/>` +
        `<h4>Fields</h4><div class="insp-fields">${rows}</div>` +
        (hasFace ? '<canvas class="insp-face" width="220" height="220"></canvas>' : '') +
        `<button class="insp-addf">+ add field</button>` +
        `<h4>Body</h4><textarea class="insp-body" rows="14">${esc(model.body)}</textarea>` +
        `<div class="sec insp-status">Changes apply automatically.</div>`;
      wire();
      const ff = q('.facefield');
      drawFace(ff ? ff.value : '');
    }

    function collect() {
      const fields = [...container.querySelectorAll('.frow')].map((r) => ({
        label: r.querySelector('.flabel').value.trim(), value: r.querySelector('.fval').value.trim(),
      })).filter((f) => f.label);
      return { display: q('.insp-display').value, fields, body: q('.insp-body').value };
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
        container.addEventListener('change', scheduleApply);
        container.addEventListener('click', onClick);
        wired = true;
      }
    }
    function onInput(e) {
      if (e.target && e.target.classList && e.target.classList.contains('facefield')) { drawFace(e.target.value); }
      scheduleApply();
    }
    function onClick(e) {
      const t = e.target;
      if (!t || !t.classList) { return; }
      if (t.classList.contains('insp-addf')) {
        const div = document.createElement('div'); div.className = 'frow';
        div.innerHTML = '<input class="flabel" placeholder="field"/><span>:</span><input class="fval" placeholder="value"/>';
        q('.insp-fields').appendChild(div);
        div.querySelector('.flabel').focus();
      } else if (t.classList.contains('facebtn')) {
        const ff = q('.facefield');
        vscode.postMessage({ type: prefix + 'buildFace', face: ff ? ff.value : '' });
      }
    }

    function render(m) { model = m || model; build(); }
    function patch(m) {
      const active = document.activeElement;
      const setIf = (el, val) => { if (el && el !== active && el.value !== val) { el.value = val; } };
      setIf(q('.insp-display'), m.display);
      setIf(q('.insp-body'), m.body);
      const rows = [...container.querySelectorAll('.frow')];
      for (const f of (m.fields || [])) {
        const row = rows.find((r) => r.querySelector('.flabel').value.trim().toLowerCase() === String(f.label).toLowerCase());
        if (row) { setIf(row.querySelector('.fval'), f.value); }
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
