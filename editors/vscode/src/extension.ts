// Artemis AMD - VSCode language client.
//
// Thin by design: all language intelligence (diagnostics, navigation, formatting)
// lives in the Python AMD language server. This extension's job is to find that
// server and launch it — and it prefers to do so through your **Artemis Cosmos
// install** rather than assuming `sbs` is on your PATH. Because `.amd` files live
// inside the Cosmos tree (`<cosmos>/data/missions/<mission>/`), the extension can
// auto-detect the install by walking up from the open file, then use that install's
// bundled Python (`PyRuntime/python`) and `data/missions/sbs.pyz`.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  Executable,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;
let output: vscode.OutputChannel;
let extensionUri: vscode.Uri | undefined;

/** The Cosmos install's bundled Python interpreter. */
function pythonExe(root: string): string {
  return process.platform === 'win32'
    ? path.join(root, 'PyRuntime', 'python.exe')
    : path.join(root, 'PyRuntime', 'python');
}

/** A folder is a Cosmos root if it has the bundled Python and a missions dir. */
function isCosmosRoot(dir: string): boolean {
  try {
    return fs.existsSync(pythonExe(dir))
        && fs.existsSync(path.join(dir, 'data', 'missions'));
  } catch {
    return false;
  }
}

function walkUpForCosmos(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (isCosmosRoot(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

/** The configured Cosmos path, or an auto-detected one from the open file / workspace. */
function detectCosmosRoot(): string | undefined {
  const configured = (vscode.workspace.getConfiguration('amd').get<string>('cosmosPath') || '').trim();
  if (configured) {
    return isCosmosRoot(configured) ? configured : undefined;
  }
  const starts: string[] = [];
  const active = vscode.window.activeTextEditor?.document?.uri;
  if (active && active.scheme === 'file') {
    starts.push(path.dirname(active.fsPath));
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === 'file') {
      starts.push(folder.uri.fsPath);
    }
  }
  for (const start of starts) {
    const root = walkUpForCosmos(start);
    if (root) {
      return root;
    }
  }
  return undefined;
}

/** Decide how to launch the server: explicit override -> Cosmos install -> `sbs` on PATH. */
function resolveServer(): Executable {
  const cfg = vscode.workspace.getConfiguration('amd');
  const explicit = (cfg.get<string>('server.command') || '').trim();
  const args = cfg.get<string[]>('server.args', ['lint', '--lsp']);

  if (explicit) {
    output.appendLine(`Server: configured command "${explicit} ${args.join(' ')}"`);
    return { command: explicit, args, options: { shell: process.platform === 'win32' } };
  }

  const root = detectCosmosRoot();
  if (root) {
    const py = pythonExe(root);
    const missions = path.join(root, 'data', 'missions');
    const sbsPyz = path.join(missions, 'sbs.pyz');
    if (fs.existsSync(py) && fs.existsSync(sbsPyz)) {
      output.appendLine(`Server: Cosmos at "${root}"`);
      output.appendLine(`        ${py} ${sbsPyz} ${args.join(' ')}`);
      return { command: py, args: [sbsPyz, ...args], options: { cwd: missions } };
    }
    output.appendLine(`Cosmos folder "${root}" is missing PyRuntime/python or sbs.pyz.`);
  }

  output.appendLine('Server: no Cosmos install found — falling back to `sbs` on PATH.');
  return { command: 'sbs', args, options: { shell: process.platform === 'win32' } };
}

function startClient(): void {
  const exec = resolveServer();
  const serverOptions: ServerOptions = { run: exec, debug: exec };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'amd' }],
    outputChannel: output,
    // The server re-reads a mission's .mast on each check; watching them lets an
    // editor nudge it after cross-file edits.
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.mast'),
    },
  };
  client = new LanguageClient('amd', 'Artemis AMD', serverOptions, clientOptions);
  client.start().catch((err) => {
    output.appendLine(`Failed to start the AMD language server: ${err}`);
    vscode.window.showErrorMessage(
      'Artemis AMD: could not start the language server. Set "amd.cosmosPath" to your Cosmos install folder.',
      'Open Settings',
    ).then((pick) => {
      if (pick) {
        vscode.commands.executeCommand('workbench.action.openSettings', 'amd.cosmosPath');
      }
    });
  });
}

// --- Mission map preview ----------------------------------------------------
interface LspRange { start: { line: number; character: number }; end: { line: number; character: number }; }
interface MapLandmark { key: string; display: string; i: number; j: number; kind: string; uri: string; line: number; addLine: number; atRange: LspRange | null; kindRange: LspRange | null; problems: Problems | null; }
interface MapRegion { key: string; display: string; i: number; j: number; radius: number; color: string; uri: string; line: number; centerRange: LspRange | null; radiusRange: LspRange | null; }
interface MissionMap { landmarks: MapLandmark[]; regions: MapRegion[]; }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Shared webview shell: a fixed toolbar (title, legend, fit/overview/zoom) over a
// bounded scroll area (real scrollbars), with zoom (buttons + Ctrl+wheel), fit-to-
// window, drag-to-pan, and a minimap overview. `.lm`/`.nd` are click-to-jump.
// `extraScript` is appended for view-specific behaviour (e.g. graph highlighting).
function webviewPage(title: string, legend: string, styles: string, body: string, nonce: string, extraScript = '', inspector?: { scripts: string; imgCsp: string }, initialView?: { zoom: number; sl: number; st: number } | null): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${inspector ? inspector.imgCsp : ''} style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
  header { flex: 0 0 auto; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border, #8883); }
  header h3 { margin: 0 0 4px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .spacer { flex: 1 1 auto; }
  .btns button { background: var(--vscode-button-secondaryBackground, #444); color: var(--vscode-button-secondaryForeground, #fff); border: none; border-radius: 4px; padding: 2px 9px; margin-left: 4px; cursor: pointer; font-size: 12px; }
  .btns button:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }
  .scroll { flex: 1 1 auto; overflow: auto; cursor: grab; }
  .scroll.grabbing { cursor: grabbing; }
  .scroll svg { display: block; }
  .leg { font-size: 11px; color: var(--vscode-descriptionForeground); margin-right: 10px; }
  .leg i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
  .empty { color: var(--vscode-descriptionForeground); padding: 10px; }
  #minimap { position: fixed; bottom: 14px; right: 14px; border: 1px solid var(--vscode-panel-border, #888); background: var(--vscode-editor-background); box-shadow: 0 2px 10px #0007; cursor: pointer; z-index: 5; }
  #minimap svg { pointer-events: none; display: block; }
  #minirect { position: absolute; border: 1.5px solid var(--vscode-focusBorder, #58f); background: rgba(90,140,255,0.15); pointer-events: none; }
  #minimap.hidden { display: none; }
  .ctxmenu { position: fixed; z-index: 50; min-width: 150px; padding: 4px 0; font-size: 13px; user-select: none;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, #8886));
    border-radius: 5px; box-shadow: 0 3px 14px #0009; }
  .ctxmenu.hidden { display: none; }
  .ctxmenu .ci { padding: 5px 14px; cursor: pointer; white-space: nowrap; }
  .ctxmenu .ci:hover { background: var(--vscode-menu-selectionBackground, #06f); color: var(--vscode-menu-selectionForeground, #fff); }
  .ctxmenu .ci.danger { color: var(--vscode-errorForeground, #f66); }
  .ctxmenu .sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, #8884); }
  #insp-drawer { position: fixed; top: 0; right: 0; width: 340px; max-width: 82vw; height: 100%; z-index: 40; overflow: auto;
    background: var(--vscode-editor-background); border-left: 1px solid var(--vscode-panel-border, #8883); box-shadow: -3px 0 14px #0007; }
  #insp-drawer.hidden { display: none; }
  #insp-drawer-bar { position: sticky; top: 0; display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px; background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, #8883); font-size: 12px; color: var(--vscode-descriptionForeground); }
  #insp-close { cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; }
  ${styles}
</style></head><body>
<header>
  <h3>${title}</h3>
  <div class="row">${legend}<span class="spacer"></span>
    <span class="btns">
      <button id="bfit" title="Fit to window">Fit</button>
      <button id="bmini" title="Toggle overview">Overview</button>
      <button id="zout" title="Zoom out">&#8722;</button><button id="zreset" title="Reset zoom">100%</button><button id="zin" title="Zoom in">+</button>
    </span>
  </div>
</header>
<div class="scroll" id="scroll">${body}</div>
<div id="minimap"><div id="minirect"></div></div>
<div id="ctxmenu" class="ctxmenu hidden"></div>
${inspector ? `<div id="insp-drawer" class="hidden"><div id="insp-drawer-bar"><span>Inspector</span><span id="insp-close" title="Close">&times;</span></div><div id="insp-mount"></div></div>` : ''}
${inspector ? inspector.scripts : ''}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const scroll = document.getElementById('scroll');
  // Shared right-click menu: items = [{label, action, danger} | {sep:true}]; send(action) posts.
  const ctxEl = document.getElementById('ctxmenu');
  function hideCtxMenu() { ctxEl.classList.add('hidden'); ctxEl.innerHTML = ''; }
  function showCtxMenu(x, y, items, send) {
    ctxEl.innerHTML = '';
    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; ctxEl.appendChild(s); continue; }
      const d = document.createElement('div');
      d.className = 'ci' + (it.danger ? ' danger' : '');
      d.textContent = it.label;
      d.addEventListener('click', (ev) => { ev.stopPropagation(); hideCtxMenu(); send(it.action); });
      ctxEl.appendChild(d);
    }
    ctxEl.classList.remove('hidden');
    const mw = ctxEl.offsetWidth, mh = ctxEl.offsetHeight;
    ctxEl.style.left = Math.max(2, Math.min(x, window.innerWidth - mw - 4)) + 'px';
    ctxEl.style.top = Math.max(2, Math.min(y, window.innerHeight - mh - 4)) + 'px';
  }
  window.addEventListener('click', hideCtxMenu);
  window.addEventListener('blur', hideCtxMenu);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideCtxMenu(); } });
  const svg = scroll.querySelector('svg');
  const baseW = svg ? parseFloat(svg.getAttribute('width')) : 0;
  const baseH = svg ? parseFloat(svg.getAttribute('height')) : 0;
  let zoom = 1;

  // --- minimap ---
  const miniWrap = document.getElementById('minimap');
  const miniRect = document.getElementById('minirect');
  let mmW = 0, mmH = 0;
  function buildMini() {
    if (!svg) { miniWrap.classList.add('hidden'); return; }
    const MAX = 190;
    const s = Math.min(MAX / baseW, MAX / baseH, 1);
    mmW = baseW * s; mmH = baseH * s;
    const clone = svg.cloneNode(true);
    clone.setAttribute('width', mmW); clone.setAttribute('height', mmH);
    miniWrap.insertBefore(clone, miniRect);
    miniWrap.style.width = mmW + 'px'; miniWrap.style.height = mmH + 'px';
  }
  function updateMini() {
    if (!svg || miniWrap.classList.contains('hidden')) { return; }
    const sw = baseW * zoom, sh = baseH * zoom;
    miniRect.style.left = (scroll.scrollLeft / sw) * mmW + 'px';
    miniRect.style.top = (scroll.scrollTop / sh) * mmH + 'px';
    miniRect.style.width = Math.min(scroll.clientWidth / sw, 1) * mmW + 'px';
    miniRect.style.height = Math.min(scroll.clientHeight / sh, 1) * mmH + 'px';
  }

  // --- zoom / fit ---
  const zreset = document.getElementById('zreset');
  function apply() { if (svg) { svg.setAttribute('width', baseW * zoom); svg.setAttribute('height', baseH * zoom); } if (zreset) zreset.textContent = Math.round(zoom * 100) + '%'; updateMini(); }
  function setZoom(z, cx, cy) {
    const sw = baseW * zoom, sh = baseH * zoom;
    const fx = sw ? (scroll.scrollLeft + (cx ?? scroll.clientWidth / 2)) / sw : 0;
    const fy = sh ? (scroll.scrollTop + (cy ?? scroll.clientHeight / 2)) / sh : 0;
    zoom = Math.max(0.2, Math.min(4, z)); apply();
    scroll.scrollLeft = fx * baseW * zoom - (cx ?? scroll.clientWidth / 2);
    scroll.scrollTop = fy * baseH * zoom - (cy ?? scroll.clientHeight / 2);
    updateMini(); reportView();
  }
  document.getElementById('zin').onclick = () => setZoom(zoom * 1.2);
  document.getElementById('zout').onclick = () => setZoom(zoom / 1.2);
  zreset.onclick = () => setZoom(1);
  function doFit() { if (svg) { setZoom(Math.min((scroll.clientWidth - 16) / baseW, (scroll.clientHeight - 16) / baseH)); } }
  document.getElementById('bfit').onclick = doFit;
  document.getElementById('bmini').onclick = () => { miniWrap.classList.toggle('hidden'); updateMini(); };
  scroll.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); const r = scroll.getBoundingClientRect(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX - r.left, e.clientY - r.top); } }, { passive: false });

  // Report pan/zoom so the extension can restore it after a refresh (no jump).
  const INITIAL_VIEW = ${initialView ? JSON.stringify(initialView) : 'null'};
  let _vsTimer = 0;
  function reportView() { clearTimeout(_vsTimer); _vsTimer = setTimeout(() => vscode.postMessage({ type: 'viewState', zoom: zoom, sl: scroll.scrollLeft, st: scroll.scrollTop }), 200); }
  scroll.addEventListener('scroll', () => { updateMini(); hideCtxMenu(); reportView(); });
  window.addEventListener('resize', updateMini);

  // --- drag to pan ---
  let panning = false, sx = 0, sy = 0, sl = 0, st = 0, moved = false;
  scroll.addEventListener('mousedown', (e) => { if (e.button !== 0) { return; } panning = true; moved = false; sx = e.clientX; sy = e.clientY; sl = scroll.scrollLeft; st = scroll.scrollTop; scroll.classList.add('grabbing'); });
  window.addEventListener('mousemove', (e) => { if (!panning) { return; } const dx = e.clientX - sx, dy = e.clientY - sy; if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; } scroll.scrollLeft = sl - dx; scroll.scrollTop = st - dy; });
  window.addEventListener('mouseup', () => { panning = false; scroll.classList.remove('grabbing'); });

  // --- minimap navigation ---
  miniWrap.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    const r = miniWrap.getBoundingClientRect();
    const sw = baseW * zoom, sh = baseH * zoom;
    scroll.scrollLeft = ((e.clientX - r.left) / mmW) * sw - scroll.clientWidth / 2;
    scroll.scrollTop = ((e.clientY - r.top) / mmH) * sh - scroll.clientHeight / 2;
    updateMini();
  });

  // --- click to jump + edit in the Inspector (suppressed after a drag) ---
  for (const g of scroll.querySelectorAll('.lm, .nd, .rg')) {
    g.addEventListener('click', () => {
      if (moved || !g.dataset.key) { return; }
      vscode.postMessage({ type: 'goto', uri: g.dataset.uri, line: parseInt(g.dataset.line, 10) });
      vscode.postMessage({ type: 'inspect', uri: g.dataset.uri, key: g.dataset.key });
    });
  }

  buildMini(); apply();
  if (INITIAL_VIEW) {
    // Restore the pan/zoom from before a refresh instead of re-fitting.
    zoom = INITIAL_VIEW.zoom; apply();
    scroll.scrollLeft = INITIAL_VIEW.sl; scroll.scrollTop = INITIAL_VIEW.st;
    updateMini();
  } else {
    // fit on open if the content is larger than the viewport
    requestAnimationFrame(() => { if (svg && (baseW > scroll.clientWidth || baseH > scroll.clientHeight)) { doFit(); } });
  }

  // --- Inspector drawer (in-webview edit panel) ---
  ${inspector ? `
  (function () {
    const drawer = document.getElementById('insp-drawer');
    const mount = document.getElementById('insp-mount');
    let handle = null;
    document.getElementById('insp-close').addEventListener('click', () => drawer.classList.add('hidden'));
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || typeof m.type !== 'string' || m.type.indexOf('insp:') !== 0) { return; }
      if (m.type === 'insp:render') {
        if (!handle) { handle = InspectorForm.mount(mount, vscode, { prefix: 'insp:', model: m.model }); }
        else { handle.render(m.model); }
        drawer.classList.remove('hidden');
      } else if (m.type === 'insp:patch' && handle) { handle.patch(m); }
      else if (m.type === 'insp:setFace' && handle) { handle.setFace(m.value); }
    });
    // Ask the extension to (re)send the current node — re-opens the drawer after
    // a full re-render of this webview.
    vscode.postMessage({ type: 'inspReady' });
  })();
  ` : ''}
  ${extraScript}
</script></body></html>`;
}

function renderMap(map: MissionMap, nonce: string, webview: vscode.Webview, initialView?: { zoom: number; sl: number; st: number } | null): string {
  const pts = [
    ...map.landmarks.map((l) => ({ i: l.i, j: l.j })),
    ...map.regions.flatMap((r) => [
      { i: r.i - r.radius, j: r.j - r.radius }, { i: r.i + r.radius, j: r.j + r.radius },
    ]),
  ];
  const minI = pts.length ? Math.min(...pts.map((p) => p.i)) - 1 : -1;
  const maxI = pts.length ? Math.max(...pts.map((p) => p.i)) + 1 : 1;
  const minJ = pts.length ? Math.min(...pts.map((p) => p.j)) - 1 : -1;
  const maxJ = pts.length ? Math.max(...pts.map((p) => p.j)) + 1 : 1;
  const cell = 44;
  const W = (maxI - minI + 1) * cell;
  const H = (maxJ - minJ + 1) * cell;
  const x = (i: number) => (i - minI) * cell + cell / 2;
  const y = (j: number) => (j - minJ) * cell + cell / 2;

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  // grid
  for (let i = minI; i <= maxI; i++) {
    svg += `<line x1="${x(i)}" y1="0" x2="${x(i)}" y2="${H}" class="grid"/>`;
  }
  for (let j = minJ; j <= maxJ; j++) {
    svg += `<line x1="0" y1="${y(j)}" x2="${W}" y2="${y(j)}" class="grid"/>`;
  }
  // regions (translucent discs; editable ones get move + resize handles)
  for (const r of map.regions) {
    const col = /^#[0-9a-fA-F]{3,8}$/.test(r.color) ? r.color : '#88aaff';
    const cx = x(r.i), cy = y(r.j), rad = r.radius * cell;
    const editable = r.centerRange && r.radiusRange;
    // Always carry the id data so a click can open the Inspector; editable
    // regions additionally carry the ranges the drag handles rewrite.
    const idData = ` data-uri="${esc(r.uri)}" data-key="${esc(r.key)}" data-line="${r.line}"`;
    const data = editable
      ? `${idData} data-i="${r.i}" data-j="${r.j}" data-radius="${r.radius}" data-centerrange='${JSON.stringify(r.centerRange)}' data-radiusrange='${JSON.stringify(r.radiusRange)}'`
      : idData;
    svg += `<g class="rg${editable ? ' editable' : ''}"${data}>`
      + `<circle class="disc" cx="${cx}" cy="${cy}" r="${rad}" fill="${col}" fill-opacity="0.15" stroke="${col}" stroke-opacity="0.5"/>`
      + `<text x="${cx}" y="${cy - rad + 14}" class="rlabel">${esc(r.display)}</text>`
      + (editable ? `<circle class="rmove" cx="${cx}" cy="${cy}" r="6"/><circle class="rhandle" cx="${cx + rad}" cy="${cy}" r="5"/>` : '')
      + `</g>`;
  }
  // landmarks (clickable; draggable when we have the editable At: range)
  for (const l of map.landmarks) {
    const drag = l.atRange ? ` data-i="${l.i}" data-j="${l.j}" data-atrange='${JSON.stringify(l.atRange)}'` : '';
    const menu = ` data-key="${esc(l.key)}" data-display="${esc(l.display)}" data-addline="${l.addLine}"${l.kindRange ? ` data-kindrange='${JSON.stringify(l.kindRange)}'` : ''}`;
    svg += `<g class="lm${l.atRange ? ' draggable' : ''}" data-uri="${esc(l.uri)}" data-line="${l.line}"${drag}${menu}>`
      + `<circle cx="${x(l.i)}" cy="${y(l.j)}" r="6" class="dot"/>`
      + `<text x="${x(l.i) + 9}" y="${y(l.j) + 4}" class="llabel">${esc(l.display)} (${l.i},${l.j})</text>`
      + (l.problems && (l.problems.error || l.problems.warning)
        ? `<circle cx="${x(l.i) + 5}" cy="${y(l.j) - 5}" r="3.5" fill="${l.problems.error ? '#f55' : '#fc4'}" stroke="#0008" stroke-width="0.5"><title>${l.problems.error} error(s), ${l.problems.warning} warning(s)</title></circle>`
        : '')
      + `</g>`;
  }
  svg += `</svg>`;

  const styles = `
  .grid { stroke: var(--vscode-editorIndentGuide-background, #8884); stroke-width: 1; }
  .dot { fill: var(--vscode-charts-orange, #e8a); stroke: var(--vscode-editor-background); stroke-width: 1.5; }
  .llabel { fill: var(--vscode-foreground); font-size: 11px; }
  .rlabel { fill: var(--vscode-descriptionForeground, #aaa); font-size: 11px; text-anchor: middle; pointer-events: none; }
  .disc { pointer-events: none; }
  .rmove { fill: var(--vscode-charts-blue, #58f); stroke: var(--vscode-editor-background); stroke-width: 1.5; cursor: move; }
  .rhandle { fill: var(--vscode-charts-blue, #58f); stroke: var(--vscode-editor-background); stroke-width: 1.5; cursor: ew-resize; }
  .rmove:hover, .rhandle:hover { fill: var(--vscode-charts-yellow, #fd6); }
  .lm { cursor: pointer; }
  .lm.draggable { cursor: move; }
  .lm:hover .dot { fill: var(--vscode-charts-yellow, #fd6); }`;
  const title = `Mission Map — ${map.landmarks.length} landmark(s), ${map.regions.length} region(s)`;
  const body = pts.length ? svg : '<p class="empty">No landmarks or regions found in this mission.</p>';
  // Drag a landmark to a new cell -> rewrite its `At: i,j` (the edit is applied to
  // the .amd and the map re-renders). Uses the shared `moved` flag so a plain click
  // still jumps to the node.
  const extraScript = `
  const GRID = { minI: ${minI}, minJ: ${minJ}, cell: ${cell} };
  for (const g of scroll.querySelectorAll('.lm.draggable')) {
    let dragging = false, dx0 = 0, dy0 = 0;
    g.addEventListener('mousedown', (e) => { if (e.button !== 0) { return; } e.stopPropagation(); dragging = true; moved = false; dx0 = e.clientX; dy0 = e.clientY; });
    window.addEventListener('mousemove', (e) => { if (!dragging) { return; } const dx = (e.clientX - dx0) / zoom, dy = (e.clientY - dy0) / zoom; if (Math.abs(dx) + Math.abs(dy) > 2) { moved = true; } g.setAttribute('transform', 'translate(' + dx + ',' + dy + ')'); });
    window.addEventListener('mouseup', (e) => {
      if (!dragging) { return; }
      dragging = false; g.removeAttribute('transform');
      if (!moved) { return; }
      const dx = (e.clientX - dx0) / zoom, dy = (e.clientY - dy0) / zoom;
      const i0 = +g.dataset.i, j0 = +g.dataset.j;
      const ox = (i0 - GRID.minI) * GRID.cell + GRID.cell / 2, oy = (j0 - GRID.minJ) * GRID.cell + GRID.cell / 2;
      const ni = Math.round((ox + dx - GRID.cell / 2) / GRID.cell) + GRID.minI;
      const nj = Math.round((oy + dy - GRID.cell / 2) / GRID.cell) + GRID.minJ;
      if (ni !== i0 || nj !== j0) { vscode.postMessage({ type: 'setAt', uri: g.dataset.uri, range: JSON.parse(g.dataset.atrange), i: ni, j: nj }); }
    });
  }
  // Regions: drag the centre handle to move, the edge handle to resize.
  let rgActive = null, rgMode = null, rgx = 0, rgy = 0;
  for (const g of scroll.querySelectorAll('.rg.editable')) {
    g.querySelector('.rmove').addEventListener('mousedown', (e) => { if (e.button !== 0) { return; } e.stopPropagation(); rgActive = g; rgMode = 'move'; moved = false; rgx = e.clientX; rgy = e.clientY; });
    g.querySelector('.rhandle').addEventListener('mousedown', (e) => { if (e.button !== 0) { return; } e.stopPropagation(); rgActive = g; rgMode = 'resize'; moved = false; rgx = e.clientX; rgy = e.clientY; });
  }
  window.addEventListener('mousemove', (e) => {
    if (!rgActive) { return; }
    moved = true;
    const dx = (e.clientX - rgx) / zoom, dy = (e.clientY - rgy) / zoom;
    if (rgMode === 'move') { rgActive.setAttribute('transform', 'translate(' + dx + ',' + dy + ')'); }
    else {
      const disc = rgActive.querySelector('.disc'), handle = rgActive.querySelector('.rhandle');
      const nr = Math.max(GRID.cell, +rgActive.dataset.radius * GRID.cell + dx);
      disc.setAttribute('r', nr); handle.setAttribute('cx', +disc.getAttribute('cx') + nr);
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (!rgActive) { return; }
    const g = rgActive, mode = rgMode; rgActive = null; rgMode = null;
    g.removeAttribute('transform');
    const dx = (e.clientX - rgx) / zoom, dy = (e.clientY - rgy) / zoom;
    if (!moved) { return; }
    if (mode === 'move') {
      const i0 = +g.dataset.i, j0 = +g.dataset.j;
      const ox = (i0 - GRID.minI) * GRID.cell + GRID.cell / 2, oy = (j0 - GRID.minJ) * GRID.cell + GRID.cell / 2;
      const ni = Math.round((ox + dx - GRID.cell / 2) / GRID.cell) + GRID.minI, nj = Math.round((oy + dy - GRID.cell / 2) / GRID.cell) + GRID.minJ;
      if (ni !== i0 || nj !== j0) { vscode.postMessage({ type: 'setRange', uri: g.dataset.uri, range: JSON.parse(g.dataset.centerrange), text: ni + ', ' + nj }); }
    } else {
      const baseR = +g.dataset.radius;
      const nr = Math.max(1, Math.round((baseR * GRID.cell + dx) / GRID.cell));
      if (nr !== baseR) { vscode.postMessage({ type: 'setRange', uri: g.dataset.uri, range: JSON.parse(g.dataset.radiusrange), text: String(nr) }); }
      else { const disc = g.querySelector('.disc'), handle = g.querySelector('.rhandle'); disc.setAttribute('r', baseR * GRID.cell); handle.setAttribute('cx', +disc.getAttribute('cx') + baseR * GRID.cell); }
    }
  });
  // Convert a client point to the nearest grid cell (i, j).
  function cellAt(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    const ux = (clientX - r.left) / zoom, uy = (clientY - r.top) / zoom;
    return { i: Math.round((ux - GRID.cell / 2) / GRID.cell) + GRID.minI,
             j: Math.round((uy - GRID.cell / 2) / GRID.cell) + GRID.minJ };
  }
  // Double-click an empty cell to create a landmark there.
  scroll.addEventListener('dblclick', (e) => {
    if (!svg || (e.target && e.target.closest && e.target.closest('.lm'))) { return; }
    const c = cellAt(e.clientX, e.clientY);
    vscode.postMessage({ type: 'addLandmark', i: c.i, j: c.j });
  });
  // Right-click empty space to create a landmark or a region at that cell.
  scroll.addEventListener('contextmenu', (e) => {
    if (!svg || (e.target && e.target.closest && (e.target.closest('.lm') || e.target.closest('.rg')))) { return; }
    e.preventDefault();
    const c = cellAt(e.clientX, e.clientY);
    showCtxMenu(e.clientX, e.clientY, [
      { label: 'New landmark here', action: 'addLandmark' },
      { label: 'New region here', action: 'addRegion' },
    ], (action) => vscode.postMessage({ type: action, i: c.i, j: c.j }));
  });
  // Right-click a landmark for Rename / Change Kind / Delete / Go to.
  for (const g of scroll.querySelectorAll('.lm')) {
    g.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const data = { type: 'lmMenu', key: g.dataset.key, display: g.dataset.display, uri: g.dataset.uri, line: parseInt(g.dataset.line, 10), addLine: parseInt(g.dataset.addline, 10), kindRange: g.dataset.kindrange ? JSON.parse(g.dataset.kindrange) : null };
      const items = [{ label: 'Edit…', action: 'Edit…' }, { label: 'Go to', action: 'Go to' }, { label: 'Rename…', action: 'Rename…' }];
      if (data.kindRange) { items.push({ label: 'Change Kind…', action: 'Change Kind…' }); }
      items.push({ sep: true }, { label: 'Delete', action: 'Delete', danger: true });
      showCtxMenu(e.clientX, e.clientY, items, (action) => vscode.postMessage({ ...data, action }));
    });
  }
  `;
  const inj = faceInjection(webview, nonce);
  return webviewPage(title, '', styles, body, nonce, extraScript,
    { scripts: inj.scripts + inspectorFormScript(webview, nonce), imgCsp: inj.imgCsp }, initialView);
}

// --- Inspector: edit a node's display / fields / body as a form ------------
// A field's schema descriptor (from amd_schema, via the LSP). `type` is the widget
// kind; the rest parameterise it. Kept loose (open record) so new descriptor keys
// added server-side flow through untouched.
interface FieldSchema { type: string; values?: string[]; open?: boolean; ref?: string; csv?: boolean; hint?: string; verbs?: Record<string, FieldSchema>; }
interface NodeField { label: string; value: string; schema?: FieldSchema; }
interface SymbolOptions { node?: string[]; side?: string[]; signal?: string[]; }
interface NodeDetail {
  key: string; display: string; uri: string; archetype?: string | null;
  displayRange: LspRange | null; fields: NodeField[]; fenceRange: LspRange | null;
  options?: SymbolOptions; bodyText: string; bodyRange: LspRange;
}

// An Inspector is one live projection of a node onto a webview — either the
// movable panel ("Edit…") or the docked, cursor-following view. Both share all
// the render + live-sync logic; the fields below are the per-host live-sync
// state. `selfEdit` swallows the echo from our own applyEdit; busy/queued
// serialises overlapping debounced applies.
interface Inspector {
  webview: vscode.Webview;
  uri: string;
  detail: NodeDetail | undefined;
  selfEdit: boolean;
  busy: boolean;
  queued?: { display: string; fields: NodeField[]; body: string };
  syncTimer?: ReturnType<typeof setTimeout>;
  prefix: string;                       // '' for standalone webviews, 'insp:' for the map/graph drawer
  render(detail: NodeDetail): void;     // full render: set webview.html (standalone) or postMessage (drawer)
  reveal(): void;
}
let panelInspector: Inspector | undefined;   // "Edit…" — a movable editor tab
let viewInspector: Inspector | undefined;    // docked in the panel, follows the caret
const drawerInspectors = new Set<Inspector>();  // in-webview drawers on the map/graph
let faceHost: Inspector | undefined;         // which inspector opened the Face builder
let viewFollowTimer: ReturnType<typeof setTimeout> | undefined;
function liveInspectors(): Inspector[] {
  return [panelInspector, viewInspector, ...drawerInspectors].filter(Boolean) as Inspector[];
}
// Fetch a node's detail and render it into a host (used by the map/graph drawer).
async function loadNodeInto(insp: Inspector, uri: string, key: string): Promise<void> {
  if (!client) { return; }
  try {
    const d = await client.sendRequest<NodeDetail | null>('amd/node', { textDocument: { uri }, key });
    if (d) { renderInspectorInto(insp, uri, d); }
  } catch { /* ignore */ }
}

function rng(r: LspRange): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

// (Field enums / widget types are no longer hardcoded here - they come from the
// LSP per field, sourced from sbs_utils.procedural.amd_schema. See formModel.)

// --- Face preview (reuses the mock's compositor, media/face.js) --------------
// The atlases live in the Cosmos install's data/graphics/. We expose that folder
// (and our media/) to the webview and hand FaceRender webview URIs for each sheet.
const FACE_SHEETS = ['Terran_Big-revised', 'Torgoth_Set', 'Skaraan_Set', 'Krailen_Set', 'Zimni_Set', 'Arvonian'];

function faceGraphicsDir(): string | undefined {
  const root = detectCosmosRoot();
  if (!root) { return undefined; }
  const dir = path.join(root, 'data', 'graphics');
  return fs.existsSync(dir) ? dir : undefined;
}

/** localResourceRoots so a face-preview webview can load media/face.js + the atlases. */
function faceWebviewRoots(): vscode.Uri[] {
  const roots: vscode.Uri[] = [];
  if (extensionUri) { roots.push(vscode.Uri.joinPath(extensionUri, 'media')); }
  const gfx = faceGraphicsDir();
  if (gfx) { roots.push(vscode.Uri.file(gfx)); }
  return roots;
}

/** Script tags + CSP img directive that bring FaceRender online in a webview.
 *  `available` is false when the Cosmos graphics folder can't be found. */
function faceInjection(webview: vscode.Webview, nonce: string): { scripts: string; imgCsp: string; available: boolean } {
  const gfx = faceGraphicsDir();
  const map: Record<string, string> = {};
  if (gfx && extensionUri) {
    for (const s of FACE_SHEETS) {
      map[s] = webview.asWebviewUri(vscode.Uri.file(path.join(gfx, s + '.png'))).toString();
    }
  }
  const faceJs = extensionUri
    ? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'face.js')).toString()
    : '';
  const scripts = `<script nonce="${nonce}" src="${faceJs}"></script>
<script nonce="${nonce}">
  (function () {
    var M = ${JSON.stringify(map)};
    window.__FACE_READY = !!(window.FaceRender && Object.keys(M).length);
    if (window.FaceRender) { FaceRender.setSheetResolver(function (fn) { return M[fn] || (fn + '.png'); }); }
  })();
</script>`;
  return { scripts, imgCsp: `img-src ${webview.cspSource};`, available: !!(gfx && extensionUri) };
}

// The node as a plain model for the shared client-side form (media/inspectorForm.js).
// `options` carries the mission-wide candidate lists the reference widgets need.
function formModel(d: NodeDetail): { key: string; display: string; fields: NodeField[]; body: string; options: SymbolOptions } {
  return { key: d.key, display: d.display, fields: d.fields, body: d.bodyText, options: d.options ?? {} };
}

// A <script> tag loading the shared form module into a webview.
function inspectorFormScript(webview: vscode.Webview, nonce: string): string {
  const uri = extensionUri
    ? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'inspectorForm.js')).toString()
    : '';
  return `<script nonce="${nonce}" src="${uri}"></script>`;
}

// The standalone Inspector webview (panel + docked view): a thin shell that
// mounts the shared form. Live-sync messages are unprefixed here (prefix "").
function renderInspector(d: NodeDetail, nonce: string, inj: { scripts: string; imgCsp: string; available: boolean }, webview: vscode.Webview): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${inj.imgCsp} style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
</style></head><body>
<div id="insp-root"></div>
${inj.scripts}
${inspectorFormScript(webview, nonce)}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const h = InspectorForm.mount(document.getElementById('insp-root'), vscode, { prefix: '', model: ${JSON.stringify(formModel(d))} });
  window.addEventListener('message', (e) => {
    const m = e.data; if (!m) { return; }
    if (m.type === 'patch') { h.patch(m); }
    else if (m.type === 'setFace') { h.setFace(m.value); }
    else if (m.type === 'render') { h.render(m.model); }
  });
</script></body></html>`;
}

// --- Face builder (per-feature; blind - faces render only in the engine) ----
interface FaceMeta { races: string[]; features: Record<string, { label: string; max: number; optional?: boolean }[]>; }
let faceBuilderPanel: vscode.WebviewPanel | undefined;

function renderFaceBuilder(meta: FaceMeta, nonce: string, inj: { scripts: string; imgCsp: string; available: boolean }, init?: { race: string; values: number[]; enables: boolean[] } | null): string {
  const note = inj.available
    ? 'Live preview composited from the Cosmos face atlases.'
    : 'No preview - set amd.cosmosPath so the face atlases can be found (they live in the Cosmos install\'s data/graphics/).';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${inj.imgCsp} style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
  h3 { margin: 0 0 8px; } label.k { display:block; font-size:11px; color: var(--vscode-descriptionForeground); margin: 10px 0 2px; }
  select, input[readonly] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #8884); border-radius: 3px; padding: 4px 6px; }
  #out { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); }
  #preview { display: block; width: 180px; height: 180px; margin: 8px 0; border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px; background: var(--vscode-input-background); }
  .srow { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
  .srow label { flex: 0 0 90px; font-size: 12px; }
  .srow input[type=range] { flex: 1 1 auto; }
  .srow .fval { flex: 0 0 24px; text-align: right; color: var(--vscode-descriptionForeground); }
  .note { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 6px 0; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer; margin-top: 10px; }
</style></head><body>
<h3>Face Builder</h3>
<label class="k">Race</label>
<select id="race">${meta.races.map((r) => `<option${init && init.race === r ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>
<div id="sliders"></div>
<canvas id="preview" width="360" height="360"></canvas>
<label class="k">Face string</label><input id="out" readonly/>
<p class="note">${esc(note)}</p>
<button id="use">Use this face</button>
${inj.scripts}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const META = ${JSON.stringify(meta.features)};
  const INIT = ${JSON.stringify(init || null)};
  let _initApplied = false;
  const raceSel = document.getElementById('race'), sliders = document.getElementById('sliders'), out = document.getElementById('out');
  const previewCanvas = document.getElementById('preview'), previewCtx = previewCanvas.getContext('2d');
  function drawPreview(str) { if (window.FaceRender) { FaceRender.drawString(previewCanvas, previewCtx, str); } }
  function renderSliders() {
    const feats = META[raceSel.value] || [];
    const useInit = INIT && !_initApplied && raceSel.value === INIT.race;
    sliders.innerHTML = feats.map((f, i) => {
      const val = (useInit && i < INIT.values.length) ? INIT.values[i] : 0;
      const en = (useInit && i < INIT.enables.length) ? INIT.enables[i] : true;
      return '<div class="srow"><label>' + f.label + '</label>' +
        (f.optional ? '<input type="checkbox" class="fen" data-i="' + i + '"' + (en ? ' checked' : '') + '>' : '<span style="width:13px"></span>') +
        '<input type="range" class="fsl" data-i="' + i + '" min="0" max="' + f.max + '" value="' + val + '"><span class="fval" data-i="' + i + '">' + val + '</span></div>';
    }).join('');
    if (useInit) { _initApplied = true; }
    sliders.querySelectorAll('.fsl').forEach((s) => s.oninput = () => { sliders.querySelector('.fval[data-i="' + s.dataset.i + '"]').textContent = s.value; build(); });
    sliders.querySelectorAll('.fen').forEach((c) => c.onchange = build);
    build();
  }
  function build() {
    const feats = META[raceSel.value] || [];
    const values = [], enables = [];
    feats.forEach((f, i) => {
      values.push(parseInt(sliders.querySelector('.fsl[data-i="' + i + '"]').value, 10));
      const c = sliders.querySelector('.fen[data-i="' + i + '"]');
      enables.push(c ? c.checked : true);
    });
    vscode.postMessage({ type: 'faceBuild', race: raceSel.value, values, enables });
  }
  raceSel.onchange = renderSliders;
  document.getElementById('use').onclick = () => vscode.postMessage({ type: 'useFace', value: out.value });
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'built') { out.value = e.data.value; drawPreview(e.data.value); } });
  renderSliders();
</script></body></html>`;
}

interface FaceInit { race: string; values: number[]; enables: boolean[]; }

async function showFaceBuilder(initialFace = ''): Promise<void> {
  if (!client) { return; }
  let meta: FaceMeta;
  try { meta = await client.sendRequest<FaceMeta>('amd/faceMeta', {}); }
  catch (e) { output.appendLine(`Face meta failed: ${e}`); return; }
  if (!meta.races.length) { vscode.window.showWarningMessage('Artemis AMD: face builder unavailable.'); return; }
  let init: FaceInit | null = null;
  if (initialFace.trim()) {
    try { init = await client.sendRequest<FaceInit | null>('amd/faceParse', { face: initialFace }); }
    catch (e) { output.appendLine(`Face parse failed: ${e}`); }
  }
  if (!faceBuilderPanel) {
    faceBuilderPanel = vscode.window.createWebviewPanel('amdFace', 'AMD Face Builder',
      vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: faceWebviewRoots() });
    faceBuilderPanel.onDidDispose(() => { faceBuilderPanel = undefined; });
    faceBuilderPanel.webview.onDidReceiveMessage(async (m) => {
      if (m?.type === 'faceBuild') {
        const r = await client!.sendRequest<{ face: string }>('amd/faceBuild', { race: m.race, values: m.values, enables: m.enables });
        faceBuilderPanel?.webview.postMessage({ type: 'built', value: r.face });
        // Live-apply to the field/drawer that opened the builder, so edits flow
        // through as you move the sliders (no need to press "Use this face").
        faceHost?.webview.postMessage({ type: (faceHost.prefix || '') + 'setFace', value: r.face });
      } else if (m?.type === 'useFace') {
        faceHost?.webview.postMessage({ type: (faceHost.prefix || '') + 'setFace', value: m.value });
      }
    });
  }
  const fbNonce = String(Date.now()) + Math.random().toString(36).slice(2);
  faceBuilderPanel.webview.html = renderFaceBuilder(meta, fbNonce, faceInjection(faceBuilderPanel.webview, fbNonce), init);
  faceBuilderPanel.reveal(vscode.ViewColumn.Beside, true);
}

// Render a node into a host (full render — first show / shown node changed).
function renderInspectorInto(insp: Inspector, uri: string, detail: NodeDetail): void {
  insp.uri = uri; insp.detail = detail;
  insp.render(detail);
}

// Attach the message handler (Face picker + live apply) to a host's webview.
// Messages are namespaced by the host's `prefix` so several forms can share one
// webview (the map/graph drawer uses "insp:").
function wireInspector(insp: Inspector): void {
  const p = insp.prefix;
  insp.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === p + 'buildFace') {
      faceHost = insp;
      const RACES: Record<string, string> = {
        'Random Terran (female)': 'terran female', 'Random Terran (male)': 'terran male',
        'Random Skaraan': 'skaraan', 'Random Torgoth': 'torgoth', 'Random Arvonian': 'arvonian',
        'Random Kralien': 'kralien', 'Random Ximni': 'ximni',
      };
      const pick = await vscode.window.showQuickPick(
        ['Build custom…', 'Paste from Avatar Editor', 'female (keyword)', 'male (keyword)', ...Object.keys(RACES)], { placeHolder: 'Face' });
      if (!pick) { return; }
      if (pick === 'Build custom…') { showFaceBuilder(typeof msg.face === 'string' ? msg.face : ''); return; }
      if (pick === 'Paste from Avatar Editor') {
        const clip = (await vscode.env.clipboard.readText()).trim();
        if (!clip) { vscode.window.showWarningMessage('Clipboard is empty — design a face in the in-game Avatar Editor first (it copies the face string on every change).'); return; }
        insp.webview.postMessage({ type: p + 'setFace', value: clip });
        return;
      }
      let value = pick.startsWith('female') ? 'female' : pick.startsWith('male') ? 'male' : '';
      if (RACES[pick]) {
        const r = await client!.sendRequest<{ face: string }>('amd/faceRandom', { race: RACES[pick] });
        value = r.face;
      }
      insp.webview.postMessage({ type: p + 'setFace', value });
      return;
    }
    if (msg?.type === p + 'faceEditor') {
      faceHost = insp;
      showFaceBuilder(typeof msg.face === 'string' ? msg.face : '');
      return;
    }
    if (msg?.type === p + 'applyNode') { await applyInspectorEdit(insp, msg); }
  });
}

// Full-render strategy for a standalone webview (panel / docked view): set html.
function standaloneRender(webview: vscode.Webview): (detail: NodeDetail) => void {
  return (detail) => {
    const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
    webview.html = renderInspector(detail, nonce, faceInjection(webview, nonce), webview);
  };
}

// "Edit…" entry — the movable panel. Creates it once, then loads the node.
async function showInspector(uri: string, key: string): Promise<void> {
  if (!client) { return; }
  let detail: NodeDetail | null;
  try {
    detail = await client.sendRequest<NodeDetail | null>('amd/node', { textDocument: { uri }, key });
  } catch (e) { output.appendLine(`Inspector failed: ${e}`); return; }
  if (!detail) { vscode.window.showWarningMessage(`Artemis AMD: node '${key}' not found.`); return; }

  if (!panelInspector) {
    const panel = vscode.window.createWebviewPanel('amdInspector', 'AMD Inspector',
      vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: faceWebviewRoots() });
    const insp: Inspector = {
      webview: panel.webview, uri: '', detail: undefined, selfEdit: false, busy: false,
      prefix: '', render: standaloneRender(panel.webview),
      reveal: () => panel.reveal(vscode.ViewColumn.Beside, true),
    };
    panel.onDidDispose(() => { if (panelInspector === insp) { panelInspector = undefined; } if (faceHost === insp) { faceHost = undefined; } });
    panelInspector = insp;
    wireInspector(insp);
  }
  renderInspectorInto(panelInspector, uri, detail);
  panelInspector.reveal();
}

// --- Preview: render a node as it would appear in-game (comms card / scan / face) ---
interface PreviewPayload {
  kind: string; key: string;
  speaker?: { key: string; name: string; color: string; face: string };
  when?: string | null; lines?: string[];
  choices?: { label: string; target: string; guard: string | null }[];
  role?: string; tab?: string;
  name?: string; color?: string; face?: string; display?: string; body?: string;
}
let previewPanel: vscode.WebviewPanel | undefined;

// "Preview" entry — resolve the node at the cursor and render its payload.
async function showPreview(): Promise<void> {
  if (!client) { return; }
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'amd') {
    vscode.window.showInformationMessage('Artemis AMD: open an .amd file and place the cursor in a node to preview it.');
    return;
  }
  const uri = ed.document.uri.toString();
  const line = ed.selection.active.line;
  let key: string | undefined;
  try {
    const at = await client.sendRequest<NodeDetail | null>('amd/nodeAtLine', { textDocument: { uri }, line });
    key = at?.key;
  } catch { /* ignore */ }
  if (!key) { vscode.window.showWarningMessage('Artemis AMD: no node at the cursor to preview.'); return; }

  let payload: PreviewPayload | null;
  try { payload = await client.sendRequest<PreviewPayload | null>('amd/preview', { textDocument: { uri }, key }); }
  catch (e) { output.appendLine(`Preview failed: ${e}`); return; }
  if (!payload) { vscode.window.showWarningMessage(`Artemis AMD: node '${key}' not found.`); return; }

  if (!previewPanel) {
    previewPanel = vscode.window.createWebviewPanel('amdPreview', 'AMD Preview',
      vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: faceWebviewRoots() });
    previewPanel.onDidDispose(() => { previewPanel = undefined; });
  }
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  previewPanel.webview.html = renderPreviewHtml(payload, nonce, faceInjection(previewPanel.webview, nonce), previewPanel.webview);
  previewPanel.title = `AMD Preview — ${payload.speaker?.name || payload.name || payload.key}`;
  previewPanel.reveal(vscode.ViewColumn.Beside, true);
}

// POST a debug command to a running `sbs debug` mock session (its stdlib server
// exposes POST /debug/command). Node's http (no extra dep); resolves on 2xx.
function postDebugCommand(port: number, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      { host: '127.0.0.1', port, path: '/debug/command', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 2000 },
      (res) => { res.resume(); (res.statusCode && res.statusCode < 300) ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data); req.end();
  });
}

// "Preview in Running Session" — push the node at the cursor into a live `sbs debug`
// browser-mock session, rendered as a story dialog (highest-fidelity preview).
async function previewInSession(): Promise<void> {
  if (!client) { return; }
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'amd') {
    vscode.window.showInformationMessage('Artemis AMD: open an .amd file and place the cursor in a node.'); return;
  }
  const uri = ed.document.uri.toString();
  let key: string | undefined;
  try {
    const at = await client.sendRequest<NodeDetail | null>('amd/nodeAtLine', { textDocument: { uri }, line: ed.selection.active.line });
    key = at?.key;
  } catch { /* ignore */ }
  if (!key) { vscode.window.showWarningMessage('Artemis AMD: no node at the cursor.'); return; }

  let payload: PreviewPayload | null;
  try { payload = await client.sendRequest<PreviewPayload | null>('amd/preview', { textDocument: { uri }, key }); }
  catch (e) { output.appendLine(`Preview failed: ${e}`); return; }
  if (!payload) { vscode.window.showWarningMessage(`Artemis AMD: node '${key}' not found.`); return; }

  const port = vscode.workspace.getConfiguration('amd').get<number>('sessionPort', 8765);
  try {
    await postDebugCommand(port, { action: 'preview', payload });
    vscode.window.setStatusBarMessage(`$(broadcast) Previewed '${key}' in session`, 3000);
  } catch (e) {
    vscode.window.showWarningMessage(`Artemis AMD: no running session on port ${port} (start one with \`sbs debug .\`). ${e}`);
  }
}

// A self-contained webview that draws the preview payload client-side: a dialogue
// comms card (coloured speaker + face + lines + choices), a scan (tab + variants),
// or a lifeform face. The face uses FaceRender (face.js) via faceInjection.
function renderPreviewHtml(p: PreviewPayload, nonce: string,
                          inj: { scripts: string; imgCsp: string; available: boolean },
                          webview: vscode.Webview): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${inj.imgCsp} style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin:0; padding:16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 14px; }
  .card { max-width: 560px; }
  .hdr { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
  .face { width:96px; height:96px; border:1px solid var(--vscode-input-border,#8884); border-radius:6px; background: var(--vscode-input-background); flex:0 0 auto; }
  .who { font-size:1.2em; font-weight:600; }
  .sub { color: var(--vscode-descriptionForeground); font-size:.8em; }
  .lines { margin: 6px 0 14px; }
  .line { padding:8px 12px; margin:6px 0; border-left:3px solid var(--vscode-focusBorder,#58f); background: var(--vscode-textBlockQuote-background,#8881); border-radius:3px; }
  .variant { color: var(--vscode-descriptionForeground); font-size:.75em; text-transform:uppercase; letter-spacing:.05em; }
  .choices { display:flex; flex-direction:column; gap:6px; }
  .choice { padding:7px 12px; border:1px solid var(--vscode-input-border,#8884); border-radius:6px; background: var(--vscode-button-secondaryBackground,#333); }
  .choice .arrow { color: var(--vscode-descriptionForeground); }
  .choice .guard { color: var(--vscode-descriptionForeground); font-size:.8em; font-style:italic; }
  h4 { margin: 14px 0 6px; color: var(--vscode-descriptionForeground); font-weight:600; }
  .tab { display:inline-block; padding:2px 10px; border-radius:10px; background: var(--vscode-badge-background,#333); color: var(--vscode-badge-foreground,#fff); font-size:.8em; }
</style></head><body>
<div id="root" class="card"></div>
${inj.scripts}
<script nonce="${nonce}">
  const P = ${JSON.stringify(p)};
  const esc = (x) => String(x==null?'':x).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const faceStr = (P.speaker && P.speaker.face) || P.face || '';
  const root = document.getElementById('root');
  function faceHtml(){ return faceStr ? '<canvas class="face" id="pv-face" width="192" height="192"></canvas>' : ''; }
  if (P.kind === 'dialogue') {
    const who = (P.speaker && P.speaker.name) || P.key;
    const color = (P.speaker && P.speaker.color) || '#0cf';
    const lines = (P.lines||[]).map((l,i)=>'<div class="line">'+(P.lines.length>1?'<span class="variant">variant '+(i+1)+'</span><br>':'')+esc(l)+'</div>').join('');
    const choices = (P.choices||[]).map((c)=>'<div class="choice">'+esc(c.label)+' <span class="arrow">&rarr; '+esc(c.target)+'</span>'+(c.guard?' <span class="guard">if '+esc(c.guard)+'</span>':'')+'</div>').join('');
    root.innerHTML = '<div class="hdr">'+faceHtml()+'<div><div class="who" style="color:'+esc(color)+'">'+esc(who)+'</div><div class="sub">'+(P.when?('when: '+esc(P.when)):'')+'</div></div></div>'
      + (lines?('<h4>Says</h4><div class="lines">'+lines+'</div>'):'')
      + (choices?('<h4>Choices</h4><div class="choices">'+choices+'</div>'):'');
  } else if (P.kind === 'scan') {
    const lines = (P.lines||[]).map((l,i)=>'<div class="line">'+((P.lines.length>1)?'<span class="variant">variant '+(i+1)+'</span><br>':'')+esc(l)+'</div>').join('');
    root.innerHTML = '<div class="hdr"><div><div class="who">'+esc(P.role||P.key)+'</div><div class="sub"><span class="tab">'+esc(P.tab||'scan')+'</span></div></div></div><div class="lines">'+lines+'</div>';
  } else if (P.kind === 'face') {
    root.innerHTML = '<div class="hdr">'+faceHtml()+'<div class="who" style="color:'+esc(P.color||'#0cf')+'">'+esc(P.name||P.key)+'</div></div>';
  } else {
    root.innerHTML = '<div class="who">'+esc(P.display||P.key)+'</div><div class="lines"><div class="line">'+esc(P.body||'')+'</div></div>';
  }
  const fc = document.getElementById('pv-face');
  if (fc && window.FaceRender && faceStr) { FaceRender.drawString(fc, fc.getContext('2d'), faceStr); }
</script></body></html>`;
}

// Docked, cursor-following Inspector in the panel area.
class InspectorViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true, localResourceRoots: faceWebviewRoots() };
    const insp: Inspector = {
      webview: view.webview, uri: '', detail: undefined, selfEdit: false, busy: false,
      prefix: '', render: standaloneRender(view.webview),
      reveal: () => view.show?.(true),
    };
    viewInspector = insp;
    wireInspector(insp);
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { margin:0; padding:14px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; }
    </style></head><body>Open an <code>.amd</code> file and place the cursor in a node to edit it here.</body></html>`;
    view.onDidDispose(() => { if (viewInspector === insp) { viewInspector = undefined; } if (faceHost === insp) { faceHost = undefined; } });
    view.onDidChangeVisibility(() => { if (view.visible) { void flushPendingInspect(); void followCaretToView(); } });
    void flushPendingInspect();
    void followCaretToView();
  }
}

// Selecting a node in the Map or Graph loads it into the docked Inspector. We
// reveal the view (which resolves it if it wasn't shown yet) and load the node.
// `pendingInspect` bridges the case where the view resolves after the request.
let pendingInspect: { uri: string; key: string } | undefined;
async function inspectInDockedView(uri: string, key: string): Promise<void> {
  pendingInspect = { uri, key };
  await vscode.commands.executeCommand('amd.inspectorView.focus');
  await flushPendingInspect();
}
async function flushPendingInspect(): Promise<void> {
  if (!pendingInspect || !viewInspector || !client) { return; }
  const { uri, key } = pendingInspect; pendingInspect = undefined;
  try {
    const d = await client.sendRequest<NodeDetail | null>('amd/node', { textDocument: { uri }, key });
    if (d) { renderInspectorInto(viewInspector, uri, d); }
  } catch { /* view will still follow the caret */ }
}

// Point the docked view at whichever node owns the active editor's caret. Only
// re-renders when the node actually changes (moving within a node is a no-op;
// value changes arrive via reverse-sync).
async function followCaretToView(): Promise<void> {
  if (!client || !viewInspector) { return; }
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'amd') { return; }
  const uri = ed.document.uri.toString();
  const line = ed.selection.active.line;
  let detail: NodeDetail | null;
  try { detail = await client.sendRequest<NodeDetail | null>('amd/nodeAtLine', { textDocument: { uri }, line }); }
  catch { return; }
  if (!detail) { return; }
  if (viewInspector.uri === uri && viewInspector.detail?.key === detail.key) { return; }
  renderInspectorInto(viewInspector, uri, detail);
}

// Write the form's current state into the .amd — only the parts that changed —
// then refresh ranges WITHOUT rebuilding the webview (so focus/caret survive).
// Serialised so a fast typist's overlapping debounces can't interleave edits.
async function applyInspectorEdit(insp: Inspector, msg: { display: string; fields: NodeField[]; body: string }): Promise<void> {
  if (!client || !insp.detail) { return; }
  if (insp.busy) { insp.queued = msg; return; }
  insp.busy = true;
  try {
    const d = insp.detail;
    const u = vscode.Uri.parse(insp.uri);
    const edit = new vscode.WorkspaceEdit();
    let changed = false;

    if (d.displayRange && msg.display !== d.display) {
      edit.replace(u, rng(d.displayRange), msg.display); changed = true;
    }
    const fieldText = msg.fields.map((f) => `${f.label}: ${f.value}`).join('\n');
    const curFields = d.fields.map((f) => `${f.label}: ${f.value}`).join('\n');
    if (fieldText !== curFields) {
      if (d.fenceRange) { edit.replace(u, rng(d.fenceRange), fieldText); }
      else if (fieldText) { edit.insert(u, new vscode.Position(d.bodyRange.start.line, 0), `---\n${fieldText}\n---\n`); }
      changed = true;
    }
    let body = msg.body;
    if (body && !body.endsWith('\n')) { body += '\n'; }
    if (body.replace(/\n$/, '') !== d.bodyText.replace(/\n$/, '')) {
      edit.replace(u, rng(d.bodyRange), body); changed = true;
    }
    if (!changed) { return; }

    insp.selfEdit = true;              // swallow the echo in onDidChangeTextDocument
    await vscode.workspace.applyEdit(edit);
    try {
      const fresh = await client.sendRequest<NodeDetail | null>('amd/node', { textDocument: { uri: insp.uri }, key: d.key });
      if (fresh) { insp.detail = fresh; }
    } catch { /* keep old ranges; next edit will re-resolve */ }
  } finally {
    insp.busy = false;
    if (insp.queued) { const q = insp.queued; insp.queued = undefined; void applyInspectorEdit(insp, q); }
  }
}

// The .amd changed elsewhere — mirror the current node's values back into a host,
// patching only fields the user isn't focused in (the webview guards that).
async function reloadInspector(insp: Inspector): Promise<void> {
  if (!client || !insp.detail) { return; }
  let fresh: NodeDetail | null;
  try {
    fresh = await client.sendRequest<NodeDetail | null>('amd/node', { textDocument: { uri: insp.uri }, key: insp.detail.key });
  } catch { return; }
  if (!fresh) { return; }   // node gone (e.g. heading retyped) — leave the last good view
  insp.detail = fresh;
  insp.webview.postMessage({ type: insp.prefix + 'patch', display: fresh.display, fields: fresh.fields, body: fresh.bodyText });
}

function wsEditFromChanges(changes: Record<string, { range: LspRange; newText: string }[]> | undefined): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  for (const [u, edits] of Object.entries(changes || {})) {
    for (const e of edits) {
      edit.replace(vscode.Uri.parse(u),
        new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character),
        e.newText);
    }
  }
  return edit;
}

async function openLocation(uriStr: string, line: number, opts?: { onlyIfVisible?: boolean }): Promise<void> {
  const uri = vscode.Uri.parse(uriStr);
  const pos = new vscode.Position(Math.max(0, line), 0);
  const range = new vscode.Range(pos, pos);
  if (opts?.onlyIfVisible) {
    // Click on the map/graph: scroll the editor to the node only if it's already
    // on screen — never open a closed file or pull a background tab forward.
    const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    if (!ed) { return; }
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch (e) {
    output.appendLine(`Could not open ${uriStr}: ${e}`);
  }
}

// --- Story graph preview ----------------------------------------------------
interface Problems { error: number; warning: number; }
interface GraphNode { key: string; display: string; section: string; uri: string; line: number; addLine: number; problems: Problems | null; }
interface GraphEdge { from: string; to: string; kind: string; uri: string; line: number; targetRange: LspRange; }
interface MissionGraph { nodes: GraphNode[]; edges: GraphEdge[]; }

type FocusDir = 'down' | 'up' | 'both';
interface Focus { key: string; dir: FocusDir; hops: number; }

// Nodes reachable from `start` within `hops` (Infinity = all), following edges
// downstream, upstream, or both.
function reachable(graph: MissionGraph, start: string, dir: FocusDir, hops: number): Set<string> {
  const down = new Map<string, string[]>(), up = new Map<string, string[]>();
  for (const e of graph.edges) {
    (down.get(e.from) ?? down.set(e.from, []).get(e.from)!).push(e.to);
    (up.get(e.to) ?? up.set(e.to, []).get(e.to)!).push(e.from);
  }
  const seen = new Set<string>([start]);
  let frontier = [start], d = 0;
  while (frontier.length && d < hops) {
    const next: string[] = [];
    for (const k of frontier) {
      const neigh: string[] = [];
      if (dir !== 'up') { neigh.push(...(down.get(k) ?? [])); }
      if (dir !== 'down') { neigh.push(...(up.get(k) ?? [])); }
      for (const t of neigh) { if (!seen.has(t)) { seen.add(t); next.push(t); } }
    }
    frontier = next; d++;
  }
  return seen;
}

function sectionHue(s: string): number {
  let h = 0;
  for (const c of s) { h = (h * 31 + c.charCodeAt(0)) % 360; }
  return h;
}

const EDGE_COLOR: Record<string, string> = {
  choice: '#7aa2f7', scene: '#9ece6a', reveal: '#e0af68', parent: '#bb9af7',
};

// Typed node templates: scaffolded into the right `##` section with sensible fields.
const NODE_TEMPLATES: Record<string, { section: string | null; sectionDisplay: string; keyBase: string; body: (k: string) => string }> = {
  'Dialogue scene': { section: 'dialogue', sectionDisplay: 'Dialogue', keyBase: 'scene', body: (k) => `\n### [New Scene](${k})\n---\nSpeaker: \nWhen: comms\n---\n% \n` },
  'Quest step': { section: 'narrative', sectionDisplay: 'Narrative', keyBase: 'quest', body: (k) => `\n### [New Quest](${k})\n---\nScope: shared\nState: secret\nWhen: \nThen: reveal \n---\nDescription.\n` },
  'Lifeform (cast)': { section: 'lifeforms', sectionDisplay: 'Lifeforms', keyBase: 'character', body: (k) => `\n### [New Character](${k})\n---\nFace: female\nRoles: advisor\nScene: \nColor: #6cf\n---\nDescription.\n` },
  'Goal': { section: 'goals', sectionDisplay: 'Goals', keyBase: 'goal', body: (k) => `\n### [New Goal](${k})\n---\nScope: shared\nState: active\nWin: true\nWhen: signal \n---\nDescription.\n` },
  'Generic node': { section: null, sectionDisplay: '', keyBase: 'new_node', body: (k) => `\n### [New Node](${k})\n` },
};

function renderGraph(fullGraph: MissionGraph, nonce: string, webview: vscode.Webview, focus?: Focus | null, initialView?: { zoom: number; sl: number; st: number } | null, collapsed?: Set<string>, hiddenSections?: Set<string>): string {
  // Focus: restrict to the flow reachable from a node, and lay out just that.
  let graph = fullGraph;
  let focusName = '';
  if (focus && fullGraph.nodes.some((n) => n.key === focus.key)) {
    const keep = reachable(fullGraph, focus.key, focus.dir, focus.hops);
    graph = {
      nodes: fullGraph.nodes.filter((n) => keep.has(n.key)),
      edges: fullGraph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    };
    focusName = fullGraph.nodes.find((n) => n.key === focus.key)?.display ?? focus.key;
  }

  // Section filter: drop hidden sections BEFORE layout so the lanes recompact.
  // Keep the full section list for the checkboxes so hidden ones can be re-shown.
  const allSections = [...new Set(graph.nodes.map((n) => n.section))].sort();
  if (hiddenSections && hiddenSections.size) {
    const secByKey = new Map(graph.nodes.map((n) => [n.key, n.section]));
    graph = {
      nodes: graph.nodes.filter((n) => !hiddenSections.has(n.section)),
      edges: graph.edges.filter((e) => !hiddenSections.has(secByKey.get(e.from) ?? '') && !hiddenSections.has(secByKey.get(e.to) ?? '')),
    };
  }

  // Collapse: fold the exclusive subtree under a collapsed node. A node is
  // hidden iff it's a down-descendant of a collapsed node AND not reachable
  // from a root by a path that avoids collapsed nodes.
  const downAdj = new Map<string, string[]>();
  for (const e of graph.edges) { (downAdj.get(e.from) ?? downAdj.set(e.from, []).get(e.from)!).push(e.to); }
  const hasChildren = new Set<string>([...downAdj.keys()].filter((k) => downAdj.get(k)!.length > 0));
  const hidden = new Set<string>();
  const hiddenCount = new Map<string, number>();
  if (collapsed && collapsed.size) {
    const indeg = new Map<string, number>(graph.nodes.map((n) => [n.key, 0]));
    for (const e of graph.edges) { indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1); }
    let roots = graph.nodes.filter((n) => (indeg.get(n.key) ?? 0) === 0).map((n) => n.key);
    if (!roots.length) { roots = graph.nodes.map((n) => n.key); }
    const clean = new Set<string>(); const q1 = [...roots];
    while (q1.length) { const k = q1.shift()!; if (clean.has(k)) { continue; } clean.add(k); if (!collapsed.has(k)) { for (const c of (downAdj.get(k) ?? [])) { q1.push(c); } } }
    const cand = new Set<string>(); const q2: string[] = [];
    for (const c of collapsed) { for (const ch of (downAdj.get(c) ?? [])) { q2.push(ch); } }
    while (q2.length) { const k = q2.shift()!; if (cand.has(k)) { continue; } cand.add(k); for (const ch of (downAdj.get(k) ?? [])) { q2.push(ch); } }
    for (const k of cand) { if (!clean.has(k)) { hidden.add(k); } }
    for (const c of collapsed) {
      let n = 0; const seen = new Set<string>(); const q3 = [...(downAdj.get(c) ?? [])];
      while (q3.length) { const k = q3.shift()!; if (seen.has(k)) { continue; } seen.add(k); if (hidden.has(k)) { n++; for (const ch of (downAdj.get(k) ?? [])) { q3.push(ch); } } }
      hiddenCount.set(c, n);
    }
    graph = { nodes: graph.nodes.filter((n) => !hidden.has(n.key)), edges: graph.edges.filter((e) => !hidden.has(e.from) && !hidden.has(e.to)) };
  }

  const NW = 190, NH = 30, HGAP = 90, VGAP = 22;
  const flowLR = true;   // swimlanes flow left-to-right (Option B)
  // Flow position = longest-path depth (cycle-safe: relax at most N times).
  const depth = new Map<string, number>(graph.nodes.map((n) => [n.key, 0]));
  for (let it = 0; it < graph.nodes.length; it++) {
    let changed = false;
    for (const e of graph.edges) {
      const nd = (depth.get(e.from) ?? 0) + 1;
      if ((depth.get(e.to) ?? 0) < nd) { depth.set(e.to, nd); changed = true; }
    }
    if (!changed) { break; }
  }
  const maxDepth = graph.nodes.reduce((m, n) => Math.max(m, depth.get(n.key) ?? 0), 0);

  // Swimlanes: one horizontal band per section, in first-appearance order.
  const secOrder: string[] = [];
  const secSeen = new Set<string>();
  for (const n of graph.nodes) { if (!secSeen.has(n.section)) { secSeen.add(n.section); secOrder.push(n.section); } }

  // Stack nodes that share a (section, depth) cell into sub-rows; order each
  // cell by the barycenter of its neighbours to keep related nodes aligned.
  const nbr = new Map<string, string[]>(graph.nodes.map((n) => [n.key, []]));
  for (const e of graph.edges) { nbr.get(e.from)?.push(e.to); nbr.get(e.to)?.push(e.from); }
  const cells = new Map<string, string[]>();
  for (const n of graph.nodes) { const kk = n.section + '|' + (depth.get(n.key) ?? 0); (cells.get(kk) ?? cells.set(kk, []).get(kk)!).push(n.key); }
  const rowInLane = new Map<string, number>();
  for (const [, arr] of cells) { arr.forEach((k, i) => rowInLane.set(k, i)); }
  for (let pass = 0; pass < 3; pass++) {
    for (const [, arr] of cells) {
      const bary = new Map<string, number>();
      for (const k of arr) { const ns = nbr.get(k)!; bary.set(k, ns.length ? ns.reduce((s, t) => s + (rowInLane.get(t) ?? 0), 0) / ns.length : (rowInLane.get(k) ?? 0)); }
      arr.sort((a, b) => (bary.get(a)! - bary.get(b)!) || a.localeCompare(b));
      arr.forEach((k, i) => rowInLane.set(k, i));
    }
  }
  // Horizontal compaction PER LANE: pack each lane's occupied depths into
  // consecutive columns (computed early so we can classify back links by column).
  const laneCol = new Map<string, Map<number, number>>();
  for (const sec of secOrder) {
    const ds = [...new Set(graph.nodes.filter((n) => n.section === sec).map((n) => depth.get(n.key) ?? 0))].sort((a, b) => a - b);
    const m = new Map<number, number>();
    ds.forEach((d, i) => m.set(d, i));
    laneCol.set(sec, m);
  }
  let maxCols = 1;
  for (const m of laneCol.values()) { maxCols = Math.max(maxCols, m.size); }
  const secByKey = new Map(graph.nodes.map((n) => [n.key, n.section]));
  const XPAD = 130;
  const nodeX = (key: string) => (laneCol.get(secByKey.get(key) ?? '')?.get(depth.get(key) ?? 0) ?? 0) * (NW + HGAP) + XPAD;

  // A "back link" targets a node in the same or a left column. Drawn as a chip
  // on the source instead of a backward line that reads against the flow.
  const backBySource = new Map<string, typeof graph.edges>();
  const forwardEdges: typeof graph.edges = [];
  for (const e of graph.edges) {
    if (nodeX(e.to) <= nodeX(e.from)) { (backBySource.get(e.from) ?? backBySource.set(e.from, []).get(e.from)!).push(e); }
    else { forwardEdges.push(e); }
  }
  const CHIP_H = 15, CHIP_GAP = 2;
  const laneChipRows = new Map<string, number>();
  for (const sec of secOrder) {
    let m = 0;
    for (const n of graph.nodes) { if (n.section === sec) { m = Math.max(m, backBySource.get(n.key)?.length ?? 0); } }
    laneChipRows.set(sec, m);
  }
  // Row height includes reserved space for a node's back-link chips.
  const rowStep = (sec: string) => NH + (laneChipRows.get(sec) ?? 0) * (CHIP_H + CHIP_GAP) + VGAP;

  const laneRows = new Map<string, number>();
  for (const sec of secOrder) {
    let h = 1;
    for (let d = 0; d <= maxDepth; d++) { h = Math.max(h, (cells.get(sec + '|' + d) ?? []).length); }
    laneRows.set(sec, h);
  }

  // Lane vertical placement.
  const LABEL_H = 22, LANE_PAD = 10, LANE_GAP = 14;
  const laneTop = new Map<string, number>();
  let yCursor = 24;
  for (const sec of secOrder) {
    laneTop.set(sec, yCursor + LABEL_H);
    yCursor += LABEL_H + laneRows.get(sec)! * rowStep(sec) + LANE_PAD + LANE_GAP;
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of graph.nodes) {
    pos.set(n.key, { x: nodeX(n.key), y: laneTop.get(n.section)! + (rowInLane.get(n.key) ?? 0) * rowStep(n.section) });
  }
  const W = maxCols * (NW + HGAP) + XPAD + 40;
  const H = Math.max(yCursor, 120);

  // Lane bands + labels, drawn behind the graph.
  let laneSvg = '';
  for (const sec of secOrder) {
    const top = laneTop.get(sec)! - LABEL_H;
    const ht = LABEL_H + laneRows.get(sec)! * rowStep(sec) + LANE_PAD;
    const hue = sectionHue(sec);
    laneSvg += `<g class="lane" data-section="${esc(sec)}">`
      + `<rect x="0" y="${top}" width="${W}" height="${ht}" rx="6" fill="hsl(${hue},45%,50%)" fill-opacity="0.06" stroke="hsl(${hue},45%,55%)" stroke-opacity="0.3"/>`
      + `<text x="12" y="${top + 15}" class="lanelabel" fill="hsl(${hue},60%,72%)">${esc(sec || 'ungrouped')}</text></g>`;
  }

  const clip = (s: string) => (s.length > 26 ? s.slice(0, 25) + '…' : s);
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${laneSvg}`;
  for (const e of forwardEdges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) { continue; }
    let d: string;
    if (flowLR) {
      // Orthogonal: out the source's right, a vertical jog, into the target's
      // left. The jog is at least a stub right of the source so a backward
      // (cross-lane) link doesn't cut back through the source node.
      const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
      if (Math.abs(y1 - y2) < 1) {
        d = `M${x1},${y1} H${x2}`;
      } else {
        const mx = Math.max((x1 + x2) / 2, x1 + 24);
        const dir = y2 > y1 ? 1 : -1;
        const r = Math.min(8, Math.abs(y2 - y1) / 2, Math.abs(mx - x1), Math.abs(x2 - mx));
        d = `M${x1},${y1} H${mx - r} Q${mx},${y1} ${mx},${y1 + dir * r} V${y2 - dir * r} Q${mx},${y2} ${mx + r},${y2} H${x2}`;
      }
    } else {
      const x1 = a.x + NW / 2, y1 = a.y + NH, x2 = b.x + NW / 2, y2 = b.y, my = (y1 + y2) / 2;
      d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
    }
    svg += `<path class="edge" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${d}" fill="none" stroke="${EDGE_COLOR[e.kind] || '#888'}" stroke-width="1.5" opacity="0.65"/>`;
    // a wider transparent hit path so the thin edge is right-clickable
    svg += `<path class="ehit" data-uri="${esc(e.uri)}" data-line="${e.line}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" data-kind="${e.kind}" data-targetrange='${JSON.stringify(e.targetRange)}' d="${d}" fill="none" stroke="transparent" stroke-width="12" pointer-events="stroke"/>`;
  }
  for (const n of graph.nodes) {
    const p = pos.get(n.key)!;
    const h = sectionHue(n.section);
    svg += `<g class="nd" data-key="${esc(n.key)}" data-display="${esc(n.display)}" data-section="${esc(n.section)}" data-uri="${esc(n.uri)}" data-line="${n.line}" data-addline="${n.addLine}" data-cx="${p.x + NW / 2}" data-cy="${p.y + NH / 2}">`
      + `<rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="6" fill="hsl(${h},45%,28%)" stroke="hsl(${h},60%,55%)"/>`
      + `<text x="${p.x + 8}" y="${p.y + 19}" class="nlabel">${esc(clip(n.display))}</text>`
      + (n.problems && (n.problems.error || n.problems.warning)
        ? `<circle cx="${p.x + NW - 6}" cy="${p.y + 6}" r="4.5" fill="${n.problems.error ? '#f55' : '#fc4'}" stroke="#0008" stroke-width="0.5"><title>${n.problems.error} error(s), ${n.problems.warning} warning(s)</title></circle>`
        : '')
      + `</g>`;
    // Collapse/expand toggle for nodes that have children (fan-out point).
    if (hasChildren.has(n.key)) {
      const isC = !!(collapsed && collapsed.has(n.key));
      const cx = flowLR ? p.x + NW : p.x + NW / 2, cy = flowLR ? p.y + NH / 2 : p.y + NH;
      const tip = isC ? `${hiddenCount.get(n.key) ?? 0} hidden — click to expand` : 'click to collapse';
      svg += `<g class="ncaret" data-key="${esc(n.key)}"><title>${esc(tip)}</title>`
        + `<circle cx="${cx}" cy="${cy}" r="7" fill="hsl(${h},45%,18%)" stroke="hsl(${h},60%,55%)"/>`
        + `<text x="${cx}" y="${cy + 3.5}" class="ncsign">${isC ? '+' : '−'}</text></g>`;
    }
  }
  // Back-link chips: a "↩ target" pill under the source (click to jump; right-click
  // to edit/delete the link) instead of a line running backward against the flow.
  const nodeByKey = new Map(graph.nodes.map((n) => [n.key, n]));
  for (const [srcKey, bes] of backBySource) {
    const p = pos.get(srcKey);
    if (!p) { continue; }
    bes.forEach((e, i) => {
      const t = nodeByKey.get(e.to);
      const label = '↩ ' + (t ? clip(t.display) : e.to);
      const cw = Math.min(NW, 22 + label.length * 6.2);
      const cy = p.y + NH + CHIP_GAP + i * (CHIP_H + CHIP_GAP);
      const col = EDGE_COLOR[e.kind] || '#888';
      svg += `<g class="blink" data-uri="${esc(e.uri)}" data-line="${e.line}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" data-kind="${e.kind}" data-targetrange='${JSON.stringify(e.targetRange)}' data-tkey="${esc(e.to)}" data-turi="${esc(t ? t.uri : e.uri)}" data-tline="${t ? t.line : 0}"><title>back link to ${esc(t ? t.display : e.to)}</title>`
        + `<rect x="${p.x}" y="${cy}" width="${cw}" height="${CHIP_H}" rx="7" fill="${col}" fill-opacity="0.18" stroke="${col}" stroke-opacity="0.55"/>`
        + `<text x="${p.x + 7}" y="${cy + 11}" class="blabel">${esc(label)}</text></g>`;
    });
  }
  svg += `</svg>`;

  const dirLabel = focus ? { down: '&#8595; down', up: '&#8593; up', both: '&#8597; both' }[focus.dir] : '';
  const hopLabel = focus ? (focus.hops === Infinity ? 'all' : String(focus.hops)) : '';
  const focusBar = focus
    ? `<button id="showall" class="lbtn">&#8592; Show all</button>`
      + `<button id="fdir" class="lbtn" title="Direction">${dirLabel}</button>`
      + `<button id="hdec" class="lbtn" title="Fewer hops">&#8722;</button>`
      + `<span class="leg">hops: ${hopLabel}</span>`
      + `<button id="hinc" class="lbtn" title="More hops">+</button>`
    : '';
  const expandBar = (collapsed && collapsed.size) ? `<button id="expandall" class="lbtn">Expand all</button>` : '';
  const legend = focusBar + expandBar
    + Object.entries(EDGE_COLOR)
      .map(([k, c]) => `<span class="leg"><i style="background:${c}"></i>${k}</span>`).join('')
    + allSections.map((s) => `<label class="filt"><input type="checkbox"${hiddenSections?.has(s) ? '' : ' checked'} data-section="${esc(s)}"> ${esc(s || 'ungrouped')}</label>`).join('');

  const styles = `
  .lbtn { background: var(--vscode-button-secondaryBackground, #444); color: var(--vscode-button-secondaryForeground, #fff); border: none; border-radius: 4px; padding: 2px 9px; margin-right: 8px; cursor: pointer; font-size: 11px; }
  .lbtn:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }
  .ehit { cursor: context-menu; }
  .nlabel { fill: #fff; font-size: 11px; }
  .nd { cursor: pointer; }
  .nd:hover rect { stroke-width: 2.5; }
  .ncaret { cursor: pointer; }
  .ncaret:hover circle { stroke-width: 2.5; }
  .ncsign { fill: #fff; font-size: 12px; text-anchor: middle; pointer-events: none; }
  .lanelabel { font-size: 12px; font-weight: 600; }
  .blink { cursor: pointer; }
  .blink:hover rect { fill-opacity: 0.35; }
  .blabel { fill: var(--vscode-foreground); font-size: 10px; pointer-events: none; }
  .filt { font-size: 11px; margin-right: 8px; color: var(--vscode-descriptionForeground); cursor: pointer; }
  .filt input { vertical-align: middle; margin-right: 2px; }`;
  const title = focus
    ? `Focus: ${esc(focusName)} — ${graph.nodes.length} node(s), ${graph.edges.length} link(s)`
    : `Story Graph — ${graph.nodes.length} node(s), ${graph.edges.length} link(s)`;
  const body = graph.nodes.length ? svg : '<p class="empty">No nodes found.</p>';
  // Hover a node -> spotlight it + direct neighbours; section checkboxes filter.
  const extraScript = `
  const edges = [...scroll.querySelectorAll('path.edge')];
  const gnodes = [...scroll.querySelectorAll('.nd')];
  function highlight(key) {
    if (!key) { for (const p of edges) { p.style.opacity = ''; p.style.strokeWidth = ''; } for (const n of gnodes) { if (n.style.display !== 'none') n.style.opacity = ''; } return; }
    const adj = new Set([key]);
    for (const p of edges) { if (p.dataset.from === key || p.dataset.to === key) { adj.add(p.dataset.from); adj.add(p.dataset.to); } }
    for (const p of edges) { const on = p.dataset.from === key || p.dataset.to === key; p.style.opacity = on ? '0.95' : '0.06'; p.style.strokeWidth = on ? '2.5' : '1.5'; }
    for (const n of gnodes) { if (n.style.display !== 'none') n.style.opacity = adj.has(n.dataset.key) ? '1' : '0.2'; }
  }
  for (const n of gnodes) { n.addEventListener('mouseenter', () => highlight(n.dataset.key)); n.addEventListener('mouseleave', () => highlight(null)); }
  // Toggling a section re-renders server-side (lanes recompact around it).
  for (const c of document.querySelectorAll('.filt input')) {
    c.addEventListener('change', () => vscode.postMessage({ type: 'toggleSection', section: c.dataset.section, hidden: !c.checked }));
  }

  // Drag from one node to another to add a choice edge (- [display](target)).
  let connecting = null, tmpLine = null;
  for (const n of gnodes) {
    n.addEventListener('mousedown', (e) => {
      if (e.button !== 0) { return; }
      e.stopPropagation(); connecting = n; moved = false;
      tmpLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tmpLine.setAttribute('x1', n.dataset.cx); tmpLine.setAttribute('y1', n.dataset.cy);
      tmpLine.setAttribute('x2', n.dataset.cx); tmpLine.setAttribute('y2', n.dataset.cy);
      tmpLine.setAttribute('stroke', '#e8c060'); tmpLine.setAttribute('stroke-width', '2'); tmpLine.setAttribute('stroke-dasharray', '5 3'); tmpLine.setAttribute('pointer-events', 'none');
      svg.appendChild(tmpLine);
    });
  }
  window.addEventListener('mousemove', (e) => {
    if (!connecting) { return; }
    moved = true;
    const r = svg.getBoundingClientRect();
    tmpLine.setAttribute('x2', (e.clientX - r.left) / zoom); tmpLine.setAttribute('y2', (e.clientY - r.top) / zoom);
  });
  window.addEventListener('mouseup', (e) => {
    if (!connecting) { return; }
    const src = connecting; connecting = null;
    if (tmpLine) { tmpLine.remove(); tmpLine = null; }
    if (!moved) { return; }
    const tgt = e.target && e.target.closest ? e.target.closest('.nd') : null;
    if (tgt && tgt !== src) {
      vscode.postMessage({ type: 'connect', uri: src.dataset.uri, addLine: parseInt(src.dataset.addline, 10), toKey: tgt.dataset.key, toDisplay: tgt.dataset.display });
    }
  });

  // Right-click a node for Focus / Rename / Delete / Go to.
  for (const n of gnodes) {
    n.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const data = { type: 'nodeMenu', key: n.dataset.key, display: n.dataset.display, uri: n.dataset.uri, line: parseInt(n.dataset.line, 10), addLine: parseInt(n.dataset.addline, 10) };
      showCtxMenu(e.clientX, e.clientY, [
        { label: 'Edit…', action: 'Edit…' }, { label: 'Focus here', action: 'Focus here' },
        { label: 'Go to', action: 'Go to' }, { label: 'Rename…', action: 'Rename…' },
        { sep: true }, { label: 'Delete', action: 'Delete', danger: true },
      ], (action) => vscode.postMessage({ ...data, action }));
    });
  }
  // Right-click a link (its hit path) to delete or rewire it.
  for (const h of scroll.querySelectorAll('path.ehit')) {
    h.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const data = { type: 'edgeMenu', uri: h.dataset.uri, line: parseInt(h.dataset.line, 10), from: h.dataset.from, to: h.dataset.to, kind: h.dataset.kind, targetRange: JSON.parse(h.dataset.targetrange) };
      const items = [];
      if (data.kind === 'choice') { items.push({ label: 'Edit choice…', action: 'Edit choice…' }); }
      items.push({ label: 'Rewire…', action: 'Rewire…' }, { sep: true }, { label: 'Delete link', action: 'Delete link', danger: true });
      showCtxMenu(e.clientX, e.clientY, items, (action) => vscode.postMessage({ ...data, action }));
    });
  }
  // Collapse / expand a subtree from a node's toggle badge.
  for (const c of scroll.querySelectorAll('.ncaret')) {
    c.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'toggleCollapse', key: c.dataset.key }); });
  }
  const expandall = document.getElementById('expandall');
  if (expandall) { expandall.addEventListener('click', () => vscode.postMessage({ type: 'expandAll' })); }
  // Back-link chips: click jumps to the target; right-click edits/deletes the link.
  for (const c of scroll.querySelectorAll('.blink')) {
    c.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'goto', uri: c.dataset.turi, line: parseInt(c.dataset.tline, 10) });
      vscode.postMessage({ type: 'inspect', uri: c.dataset.turi, key: c.dataset.tkey });
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const data = { type: 'edgeMenu', uri: c.dataset.uri, line: parseInt(c.dataset.line, 10), from: c.dataset.from, to: c.dataset.to, kind: c.dataset.kind, targetRange: JSON.parse(c.dataset.targetrange) };
      const items = [];
      if (data.kind === 'choice') { items.push({ label: 'Edit choice…', action: 'Edit choice…' }); }
      items.push({ label: 'Rewire…', action: 'Rewire…' }, { sep: true }, { label: 'Delete link', action: 'Delete link', danger: true });
      showCtxMenu(e.clientX, e.clientY, items, (action) => vscode.postMessage({ ...data, action }));
    });
  }
  const showall = document.getElementById('showall');
  if (showall) { showall.addEventListener('click', () => vscode.postMessage({ type: 'focus', key: null })); }
  const fdir = document.getElementById('fdir');
  if (fdir) { fdir.addEventListener('click', () => vscode.postMessage({ type: 'focusDir' })); }
  const hdec = document.getElementById('hdec');
  if (hdec) { hdec.addEventListener('click', () => vscode.postMessage({ type: 'focusHops', delta: -1 })); }
  const hinc = document.getElementById('hinc');
  if (hinc) { hinc.addEventListener('click', () => vscode.postMessage({ type: 'focusHops', delta: 1 })); }
  // Double-click empty canvas to create a new node.
  scroll.addEventListener('dblclick', (e) => {
    if (e.target && e.target.closest && (e.target.closest('.nd') || e.target.closest('.ehit'))) { return; }
    vscode.postMessage({ type: 'addNode' });
  });
  `;
  const inj = faceInjection(webview, nonce);
  return webviewPage(title, legend, styles, body, nonce, extraScript,
    { scripts: inj.scripts + inspectorFormScript(webview, nonce), imgCsp: inj.imgCsp }, initialView);
}

async function showGraph(): Promise<void> {
  if (!client) {
    vscode.window.showWarningMessage('Artemis AMD: the language server is not running.');
    return;
  }
  const uri = vscode.window.activeTextEditor?.document.uri.toString();
  if (!uri) { return; }
  let graph: MissionGraph;
  try {
    graph = await client.sendRequest<MissionGraph>('amd/graph', { textDocument: { uri } });
  } catch (e) {
    vscode.window.showErrorMessage(`Artemis AMD: could not build the graph (${e}).`);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'amdGraph', 'AMD Story Graph', vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: faceWebviewRoots() },
  );
  const nonce = () => String(Date.now()) + Math.random().toString(36).slice(2);
  let focus: Focus | null = null;
  let lastView: { zoom: number; sl: number; st: number } | null = null;
  const collapsed = new Set<string>();
  const hiddenSections = new Set<string>();
  panel.webview.html = renderGraph(graph, nonce(), panel.webview, focus, null, collapsed, hiddenSections);

  const drawer: Inspector = {
    webview: panel.webview, uri: '', detail: undefined, selfEdit: false, busy: false,
    prefix: 'insp:',
    render: (d) => panel.webview.postMessage({ type: 'insp:render', model: formModel(d) }),
    reveal: () => { /* the drawer reveals itself on render */ },
  };
  drawerInspectors.add(drawer);
  wireInspector(drawer);

  const refresh = async () => {
    try {
      const g = await client!.sendRequest<MissionGraph>('amd/graph', { textDocument: { uri } });
      panel.webview.html = renderGraph(g, nonce(), panel.webview, focus, lastView, collapsed, hiddenSections);
    } catch (e) { output.appendLine(`Graph refresh failed: ${e}`); }
  };
  // One debounced refresh path for both own gestures and external edits.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { void refresh(); }, 250); };
  // Refresh when the mission's .amd changes elsewhere (text editor, inspector),
  // but not while this graph's own drawer is applying an edit (keeps its focus).
  const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.languageId === 'amd' && !drawer.busy) { scheduleRefresh(); }
  });
  panel.onDidDispose(() => { drawerInspectors.delete(drawer); if (faceHost === drawer) { faceHost = undefined; } docSub.dispose(); });

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === 'goto') {
      openLocation(msg.uri, msg.line, { onlyIfVisible: true });   // scroll only if already on screen; never steal focus or open a tab
    } else if (msg?.type === 'viewState') {
      lastView = { zoom: msg.zoom, sl: msg.sl, st: msg.st };
    } else if (msg?.type === 'toggleCollapse') {
      if (collapsed.has(msg.key)) { collapsed.delete(msg.key); } else { collapsed.add(msg.key); }
      scheduleRefresh();
    } else if (msg?.type === 'expandAll') {
      collapsed.clear(); scheduleRefresh();
    } else if (msg?.type === 'toggleSection') {
      if (msg.hidden) { hiddenSections.add(msg.section); } else { hiddenSections.delete(msg.section); }
      scheduleRefresh();
    } else if (msg?.type === 'inspect') {
      await loadNodeInto(drawer, msg.uri, msg.key);
    } else if (msg?.type === 'inspReady') {
      if (drawer.detail) { drawer.render(drawer.detail); }
    } else if (msg?.type === 'connect' && msg.toKey) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(vscode.Uri.parse(msg.uri), new vscode.Position(msg.addLine, 0),
        `- [${msg.toDisplay}](${msg.toKey})\n`);
      await vscode.workspace.applyEdit(edit);
      scheduleRefresh();
    } else if (msg?.type === 'nodeMenu') {
      const pick = msg.action || await vscode.window.showQuickPick(['Edit…', 'Focus here', 'Go to', 'Rename…', 'Delete'],
        { placeHolder: `${msg.display} (${msg.key})` });
      if (pick === 'Edit…') {
        showInspector(uri, msg.key);
      } else if (pick === 'Focus here') {
        focus = { key: msg.key, dir: 'down', hops: Infinity }; scheduleRefresh();
      } else if (pick === 'Go to') {
        openLocation(msg.uri, msg.line);
      } else if (pick === 'Rename…') {
        const nn = await vscode.window.showInputBox({
          prompt: `Rename node key '${msg.key}' across the whole mission`, value: msg.key,
          validateInput: (v) => /^[A-Za-z0-9_]+$/.test(v) ? null : 'Use letters, digits, or underscore only',
        });
        if (nn && nn !== msg.key) {
          const we = await client!.sendRequest<{ changes: Record<string, { range: LspRange; newText: string }[]> }>(
            'amd/rename', { textDocument: { uri }, key: msg.key, newName: nn });
          await vscode.workspace.applyEdit(wsEditFromChanges(we.changes));
          scheduleRefresh();
        }
      } else if (pick === 'Delete') {
        const ok = await vscode.window.showWarningMessage(
          `Delete node "${msg.display}"? Its content is removed and references to it will dangle.`,
          { modal: true }, 'Delete');
        if (ok === 'Delete') {
          const edit = new vscode.WorkspaceEdit();
          edit.delete(vscode.Uri.parse(msg.uri), new vscode.Range(msg.line, 0, msg.addLine, 0));
          await vscode.workspace.applyEdit(edit);
          scheduleRefresh();
        }
      }
    } else if (msg?.type === 'edgeMenu') {
      const items = msg.kind === 'choice' ? ['Edit choice…', 'Delete link', 'Rewire…'] : ['Delete link', 'Rewire…'];
      const pick = msg.action || await vscode.window.showQuickPick(items,
        { placeHolder: `${msg.from} → ${msg.to} (${msg.kind})` });
      if (pick === 'Edit choice…') {
        const c = await client!.sendRequest<{ label: string; target: string; trailer: string; range: LspRange } | null>(
          'amd/choice', { textDocument: { uri: msg.uri }, line: msg.line });
        if (!c) { vscode.window.showWarningMessage('Artemis AMD: that link is not an editable choice.'); return; }
        const label = await vscode.window.showInputBox({ prompt: 'Choice label (button text)', value: c.label });
        if (label === undefined) { return; }
        const trailer = await vscode.window.showInputBox({
          prompt: 'Guard / outcomes (raw text after the target)', value: c.trailer,
          placeHolder: ' if credits >= 10 ; costs 10 credits, signal buy',
        });
        if (trailer === undefined) { return; }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(vscode.Uri.parse(msg.uri), rng(c.range), `- [${label}](${c.target})${trailer}`);
        await vscode.workspace.applyEdit(edit);
        scheduleRefresh();
      } else if (pick === 'Delete link') {
        const edit = new vscode.WorkspaceEdit();
        edit.delete(vscode.Uri.parse(msg.uri), new vscode.Range(msg.line, 0, msg.line + 1, 0));
        await vscode.workspace.applyEdit(edit);
        scheduleRefresh();
      } else if (pick === 'Rewire…') {
        const g = await client!.sendRequest<MissionGraph>('amd/graph', { textDocument: { uri } });
        const items = g.nodes.filter((n) => n.key !== msg.from).map((n) => ({ label: n.key, description: n.display }));
        const target = await vscode.window.showQuickPick(items, { placeHolder: `Rewire ${msg.from}'s link to…` });
        if (target) {
          const r = msg.targetRange;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(vscode.Uri.parse(msg.uri),
            new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character), target.label);
          await vscode.workspace.applyEdit(edit);
          scheduleRefresh();
        }
      }
    } else if (msg?.type === 'focus') {
      focus = msg.key ? { key: msg.key, dir: 'down', hops: Infinity } : null;
      scheduleRefresh();
    } else if (msg?.type === 'focusDir' && focus) {
      focus.dir = focus.dir === 'down' ? 'up' : focus.dir === 'up' ? 'both' : 'down';
      scheduleRefresh();
    } else if (msg?.type === 'focusHops' && focus) {
      focus.hops = msg.delta < 0
        ? (focus.hops === Infinity ? 5 : Math.max(1, focus.hops - 1))
        : (focus.hops === Infinity ? Infinity : (focus.hops >= 5 ? Infinity : focus.hops + 1));
      scheduleRefresh();
    } else if (msg?.type === 'addNode') {
      const typeName = await vscode.window.showQuickPick(Object.keys(NODE_TEMPLATES),
        { placeHolder: 'New node type' });
      if (!typeName) { return; }
      const t = NODE_TEMPLATES[typeName];
      const g = await client!.sendRequest<MissionGraph>('amd/graph', { textDocument: { uri } });
      const keys = new Set(g.nodes.map((n) => n.key));
      let key = t.keyBase, i = 2;
      while (keys.has(key)) { key = `${t.keyBase}_${i++}`; }
      let insertLine: number, needHeader = false;
      if (t.section) {
        const si = await client!.sendRequest<{ line: number; exists: boolean }>(
          'amd/sectionInsert', { textDocument: { uri }, section: t.section });
        insertLine = si.line; needHeader = !si.exists;
      } else {
        const d = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        insertLine = d.lineCount;
      }
      let text = t.body(key);
      if (needHeader) { text = `\n## [${t.sectionDisplay}](${t.section})${text}`; }
      const edit = new vscode.WorkspaceEdit();
      edit.insert(vscode.Uri.parse(uri), new vscode.Position(insertLine, 0), text);
      await vscode.workspace.applyEdit(edit);
      scheduleRefresh();
      showInspector(uri, key);   // open the inspector on the new node to fill it in
    }
  });
}

async function showMap(): Promise<void> {
  if (!client) {
    vscode.window.showWarningMessage('Artemis AMD: the language server is not running.');
    return;
  }
  const uri = vscode.window.activeTextEditor?.document.uri.toString();
  if (!uri) {
    return;
  }
  let map: MissionMap;
  try {
    map = await client.sendRequest<MissionMap>('amd/map', { textDocument: { uri } });
  } catch (e) {
    vscode.window.showErrorMessage(`Artemis AMD: could not build the map (${e}).`);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'amdMap', 'AMD Mission Map', vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: faceWebviewRoots() },
  );
  const nonce = () => String(Date.now()) + Math.random().toString(36).slice(2);
  let lastView: { zoom: number; sl: number; st: number } | null = null;
  panel.webview.html = renderMap(map, nonce(), panel.webview);

  const drawer: Inspector = {
    webview: panel.webview, uri: '', detail: undefined, selfEdit: false, busy: false,
    prefix: 'insp:',
    render: (d) => panel.webview.postMessage({ type: 'insp:render', model: formModel(d) }),
    reveal: () => { /* the drawer reveals itself on render */ },
  };
  drawerInspectors.add(drawer);
  wireInspector(drawer);

  const refresh = async () => {
    try {
      const m = await client!.sendRequest<MissionMap>('amd/map', { textDocument: { uri } });
      panel.webview.html = renderMap(m, nonce(), panel.webview, lastView);
    } catch (e) { output.appendLine(`Map refresh failed: ${e}`); }
  };
  // One debounced refresh path for both own gestures and external edits.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { void refresh(); }, 250); };
  // Refresh when the mission's .amd changes elsewhere (text editor, inspector),
  // but not while this map's own drawer is applying an edit (keeps its focus).
  const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.languageId === 'amd' && !drawer.busy) { scheduleRefresh(); }
  });
  panel.onDidDispose(() => { drawerInspectors.delete(drawer); if (faceHost === drawer) { faceHost = undefined; } docSub.dispose(); });

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === 'goto') {
      openLocation(msg.uri, msg.line, { onlyIfVisible: true });   // scroll only if already on screen; never steal focus or open a tab
    } else if (msg?.type === 'viewState') {
      lastView = { zoom: msg.zoom, sl: msg.sl, st: msg.st };
    } else if (msg?.type === 'inspect') {
      await loadNodeInto(drawer, msg.uri, msg.key);
    } else if (msg?.type === 'inspReady') {
      if (drawer.detail) { drawer.render(drawer.detail); }
    } else if (msg?.type === 'addRegion') {
      const d = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      const key = `region_${msg.i}_${msg.j}`.replace(/-/g, 'm');
      const stub = `\n### [New Region](${key})\n---\nCenter: ${msg.i}, ${msg.j}\nRadius: 4\nColor: #57f\n---\n`;
      const edit = new vscode.WorkspaceEdit();
      edit.insert(vscode.Uri.parse(uri), new vscode.Position(d.lineCount, 0), stub);
      await vscode.workspace.applyEdit(edit);
      scheduleRefresh();
    } else if (msg?.type === 'setAt' && msg.range) {
      const edit = new vscode.WorkspaceEdit();
      const r = msg.range;
      edit.replace(vscode.Uri.parse(msg.uri),
        new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character),
        `${msg.i}, ${msg.j}`);
      await vscode.workspace.applyEdit(edit);
      scheduleRefresh();   // re-render at the new position
    } else if (msg?.type === 'setRange' && msg.range) {
      const edit = new vscode.WorkspaceEdit();
      const r = msg.range;
      edit.replace(vscode.Uri.parse(msg.uri),
        new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character), msg.text);
      await vscode.workspace.applyEdit(edit);
      scheduleRefresh();
    } else if (msg?.type === 'addLandmark') {
      const d = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      const key = `landmark_${msg.i}_${msg.j}`.replace(/-/g, 'm');
      const stub = `\n### [New Landmark](${key})\n---\nAt: ${msg.i}, ${msg.j}\nKind: derelict\n---\n`;
      const edit = new vscode.WorkspaceEdit();
      edit.insert(vscode.Uri.parse(uri), new vscode.Position(d.lineCount, 0), stub);
      await vscode.workspace.applyEdit(edit);
      scheduleRefresh();
    } else if (msg?.type === 'lmMenu') {
      const items = ['Edit…', 'Go to', 'Rename…'];
      if (msg.kindRange) { items.push('Change Kind…'); }
      items.push('Delete');
      const pick = msg.action || await vscode.window.showQuickPick(items, { placeHolder: `${msg.display} (${msg.key})` });
      if (pick === 'Edit…') {
        showInspector(uri, msg.key);
      } else if (pick === 'Go to') {
        openLocation(msg.uri, msg.line);
      } else if (pick === 'Rename…') {
        const nn = await vscode.window.showInputBox({
          prompt: `Rename landmark key '${msg.key}' across the whole mission`, value: msg.key,
          validateInput: (v) => /^[A-Za-z0-9_]+$/.test(v) ? null : 'Use letters, digits, or underscore only',
        });
        if (nn && nn !== msg.key) {
          const we = await client!.sendRequest<{ changes: Record<string, { range: LspRange; newText: string }[]> }>(
            'amd/rename', { textDocument: { uri }, key: msg.key, newName: nn });
          await vscode.workspace.applyEdit(wsEditFromChanges(we.changes));
          scheduleRefresh();
        }
      } else if (pick === 'Change Kind…') {
        const kind = await vscode.window.showQuickPick(['derelict', 'station', 'worldlet'],
          { placeHolder: 'Landmark kind' });
        if (kind) {
          const r = msg.kindRange;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(vscode.Uri.parse(msg.uri),
            new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character), kind);
          await vscode.workspace.applyEdit(edit);
          scheduleRefresh();
        }
      } else if (pick === 'Delete') {
        const ok = await vscode.window.showWarningMessage(
          `Delete landmark "${msg.display}"? Its content is removed and references to it will dangle.`,
          { modal: true }, 'Delete');
        if (ok === 'Delete') {
          const edit = new vscode.WorkspaceEdit();
          edit.delete(vscode.Uri.parse(msg.uri), new vscode.Range(msg.line, 0, msg.addLine, 0));
          await vscode.workspace.applyEdit(edit);
          scheduleRefresh();
        }
      }
    }
  });
}

const AMD_SCAFFOLD = `# [My Mission](my_mission)
---
Display: My Mission
---
A short description shown in the quest log.

## [Scenario](scenario)
---
Mode: story
---

## [Lifeforms](lifeforms)

### [Guide](guide)
---
Face: female
Roles: advisor, guide
Scene: guide_hail
Color: #6cf
---
Your mission advisor - hail on the Ultra-Beam.

## [Dialogue](dialogue)

### [Guide](guide_hail)
---
Speaker: guide
When: comms
---
% Hello, captain. What do you need?

- [Tell me the plan](guide_plan)

### [The Plan](guide_plan)
---
Speaker: guide
---
% Head to the first site and scan it.

## [Narrative](narrative)

### [The Arc](arc)
---
Scope: shared
State: active
---
The main quest line.

#### [First Step](step1)
---
Scope: shared
State: secret
When: reach 2, 0
---
Engage the jump drive and follow the heading.

## [Goals](goals)

### [Win](goal_win)
---
Scope: shared
State: active
When: signal mission_done
Win: true
---
Complete the mission.

## [Regions](regions)

### [Home Region](home)
---
Center: 0, 0
Radius: 8
Skybox: sky-neb2-rvb
Color: #86c
---
The starting area.

## [Landmarks](landmarks)

### [First Site](site1)
---
At: 2, 0
Kind: derelict
---
The first objective, out at (2, 0).
`;

async function newContentFile(): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'New AMD content file name', value: 'content.amd',
    validateInput: (v) => v.trim().endsWith('.amd') ? null : 'File name must end in .amd',
  });
  if (!name) { return; }
  const active = vscode.window.activeTextEditor?.document.uri;
  const baseDir = active && active.scheme === 'file'
    ? vscode.Uri.joinPath(active, '..')
    : vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!baseDir) { vscode.window.showErrorMessage('Artemis AMD: open a folder first.'); return; }
  const target = vscode.Uri.joinPath(baseDir, name.trim());
  try {
    await vscode.workspace.fs.stat(target);
    const ok = await vscode.window.showWarningMessage(`${name} already exists. Overwrite?`, { modal: true }, 'Overwrite');
    if (ok !== 'Overwrite') { return; }
  } catch { /* doesn't exist - good */ }
  await vscode.workspace.fs.writeFile(target, Buffer.from(AMD_SCAFFOLD, 'utf8'));
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc);
  showMap(); showGraph();
}

// --- MAST debugger (Debug Adapter Protocol) --------------------------------
// The adapter is `sbs dap`, launched over stdio exactly like the lint LSP
// server. All debug logic lives in cosmos_dev/mast_dap.py; this just spawns it.

/** Build the DebugAdapterExecutable that runs `sbs dap <mission>` over stdio. */
function resolveDapExecutable(session: vscode.DebugSession): vscode.DebugAdapterExecutable {
  const cfg = session.configuration || {};
  let mission: string | undefined = cfg.mission;
  const program: string | undefined = cfg.program;
  if (!mission && program) { mission = path.dirname(program); }
  if (!mission) { mission = session.workspaceFolder?.uri.fsPath; }
  if (!mission) { mission = '.'; }

  const dapArgs = ['dap', mission];
  const root = detectCosmosRoot();
  if (root) {
    const py = pythonExe(root);
    const missions = path.join(root, 'data', 'missions');
    const sbsPyz = path.join(missions, 'sbs.pyz');
    if (fs.existsSync(py) && fs.existsSync(sbsPyz)) {
      output.appendLine(`DAP: ${py} ${sbsPyz} ${dapArgs.join(' ')}`);
      return new vscode.DebugAdapterExecutable(py, [sbsPyz, ...dapArgs], { cwd: missions });
    }
  }
  output.appendLine('DAP: no Cosmos install found — falling back to `sbs` on PATH.');
  return new vscode.DebugAdapterExecutable('sbs', dapArgs);
}

/** Poll a TCP port until it accepts a connection (the mission takes a few
 *  seconds to boot and bind), so a one-click compound attach doesn't race it. */
function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ host, port });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`no MAST debug adapter on ${host}:${port} — is the mission running with --dap-port?`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

class MastDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    // attach: connect to a mission already serving DAP (mission_runner/sbs debug
    // --dap-port). launch: spawn `sbs dap` over stdio.
    if (session.configuration.request === 'attach') {
      const port = session.configuration.port ?? 4711;
      const host = session.configuration.host ?? '127.0.0.1';
      output.appendLine(`DAP attach: waiting for ${host}:${port} …`);
      return waitForPort(host, port, 30000).then(() => {
        output.appendLine(`DAP attach: connected ${host}:${port}`);
        return new vscode.DebugAdapterServer(port, host);
      });
    }
    return resolveDapExecutable(session);
  }
}

/** Fill in sensible defaults so F5 works on the open .mast with no launch.json. */
class MastDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (!config.type && !config.request && !config.name) {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc && doc.fileName.endsWith('.mast')) {
        config.type = 'mast';
        config.name = 'Debug MAST';
        config.request = 'launch';
        config.program = '${file}';
      }
    }
    if (config.type === 'mast' && !config.program) {
      config.program = '${file}';
    }
    return config;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Artemis AMD');
  extensionUri = context.extensionUri;

  // MAST source debugger.
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('mast', new MastDebugAdapterFactory()));
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('mast', new MastDebugConfigurationProvider()));

  context.subscriptions.push(vscode.commands.registerCommand('amd.showMap', showMap));
  context.subscriptions.push(vscode.commands.registerCommand('amd.showGraph', showGraph));
  context.subscriptions.push(vscode.commands.registerCommand('amd.showPreview', showPreview));
  context.subscriptions.push(vscode.commands.registerCommand('amd.previewInSession', previewInSession));
  context.subscriptions.push(vscode.commands.registerCommand('amd.newFile', newContentFile));

  // Docked, cursor-following Inspector view.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('amd.inspectorView', new InspectorViewProvider(),
      { webviewOptions: { retainContextWhenHidden: true } }));
  const followSoon = () => { clearTimeout(viewFollowTimer); viewFollowTimer = setTimeout(() => { void followCaretToView(); }, 120); };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => followSoon()));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((e) => {
    if (e.textEditor === vscode.window.activeTextEditor) { followSoon(); }
  }));

  // Reverse sync: when an Inspector's .amd changes elsewhere, mirror it back into
  // that host's form (debounced; a host's own edit is swallowed by its selfEdit).
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const changed = e.document.uri.toString();
    for (const insp of liveInspectors()) {
      if (insp.uri !== changed || !insp.detail) { continue; }
      if (insp.selfEdit) { insp.selfEdit = false; continue; }
      clearTimeout(insp.syncTimer);
      insp.syncTimer = setTimeout(() => { void reloadInspector(insp); }, 250);
    }
  }));

  // Restart the server when the relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('amd.cosmosPath')
          || e.affectsConfiguration('amd.server')) {
        output.appendLine('Configuration changed — restarting server.');
        await client?.stop().catch(() => undefined);
        startClient();
      }
    }),
  );

  startClient();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
