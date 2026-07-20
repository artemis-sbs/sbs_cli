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
import * as cp from 'child_process';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  Executable,
  State,
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

// The LSP client starts asynchronously; a command fired before it reaches the
// Running state throws "Client is not running". Wait (briefly) for it to come up,
// restarting it if it had stopped, so tools opened during startup don't fail.
async function ensureClientReady(timeoutMs = 8000): Promise<boolean> {
  if (!client) { return false; }
  if (client.isRunning()) { return true; }
  if (client.state === State.Stopped) {
    client.start().catch((e) => output.appendLine(`AMD language server restart failed: ${e}`));
  }
  return await new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => { clearTimeout(timer); sub.dispose(); resolve(ok); };
    const timer = setTimeout(() => done(!!client && client.isRunning()), timeoutMs);
    const sub = client!.onDidChangeState((e) => { if (e.newState === State.Running) { done(true); } });
    if (client!.isRunning()) { done(true); }
  });
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
function webviewPage(title: string, legend: string, styles: string, body: string, nonce: string, extraScript = '', inspector?: { scripts: string; imgCsp: string }, initialView?: { zoom: number; sl: number; st: number } | null, toolbar = ''): string {
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
  ${AMD_TOOLBAR_CSS}
  ${styles}
</style></head><body>
${toolbar}
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
  ${AMD_TOOLBAR_JS}
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
    { scripts: inj.scripts + inspectorFormScript(webview, nonce), imgCsp: inj.imgCsp }, initialView, amdToolbar('map'));
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
const drawerInspectors = new Set<Inspector>();  // in-webview drawers on the map/graph
let faceHost: Inspector | undefined;         // which inspector opened the Face builder
function liveInspectors(): Inspector[] {
  return [panelInspector, ...drawerInspectors].filter(Boolean) as Inspector[];
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

async function openLocation(uriStr: string, line: number, opts?: { onlyIfVisible?: boolean; preserveFocus?: boolean }): Promise<void> {
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
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One, preview: true, preserveFocus: opts?.preserveFocus ?? false,
    });
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

// --- AMD Live Resolver model (from the `amd/resolve` LSP request) ------------
interface ResolveEntity {
  key: string; display: string; section: string; archetype: string; level: number;
  uri: string; line: number; summary: string; fields: { label: string; value: string }[];
  problems: Problems | null; inbound: number; outbound: number; orphan: boolean;
}
interface ResolveRef {
  kind: string; value: string; owner: string; uri: string; line: number;
  resolved: boolean; code: string | null;
}
interface ResolveIssue { uri: string; line: number; col: number; severity: string; code: string; message: string; }
interface ResolveModel { entities: ResolveEntity[]; refs: ResolveRef[]; issues: ResolveIssue[]; }
// A ready-to-insert skeleton for a new record under a `## section` (amd/newInSection).
interface NewInSection { line: number; text: string; key: string; archetype: string | null; exists: boolean; }

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
      + `<text x="12" y="${top + 15}" class="lanelabel" fill="hsl(${hue},60%,72%)">${esc(sec || 'ungrouped')}</text>`
      + (sec ? `<text x="${W - 46}" y="${top + 15}" class="laneadd" data-section="${esc(sec)}" fill="hsl(${hue},60%,72%)"><title>Add a new entity to this section</title>+ add</text>` : '')
      + `</g>`;
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
  const searchBar = `<input id="gsearch" class="gsearch" type="search" placeholder="Search nodes…" title="Filter nodes by name — Enter cycles matches, Shift+Enter reverse"><span class="leg" id="gscount"></span>`;
  const legend = searchBar + focusBar + expandBar
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
  .laneadd { font-size: 11px; cursor: pointer; opacity: 0.7; }
  .laneadd:hover { opacity: 1; text-decoration: underline; }
  .blink { cursor: pointer; }
  .blink:hover rect { fill-opacity: 0.35; }
  .blabel { fill: var(--vscode-foreground); font-size: 10px; pointer-events: none; }
  .filt { font-size: 11px; margin-right: 8px; color: var(--vscode-descriptionForeground); cursor: pointer; }
  .filt input { vertical-align: middle; margin-right: 2px; }
  .gsearch { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #8883); border-radius: 4px; padding: 2px 8px; font-size: 11px; margin-right: 6px; width: 150px; }
  .gsearch:focus { outline: 1px solid var(--vscode-focusBorder, #4ec9b0); }
  .nd.ndim { opacity: 0.18; }
  .nd.nmatch rect { stroke: var(--vscode-focusBorder, #4ec9b0); stroke-width: 2.5; }
  path.edge.edim { opacity: 0.05; }`;
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
  // Search box: filter/spotlight matching nodes; Enter cycles + centers matches.
  const gsearch = document.getElementById('gsearch');
  const gscount = document.getElementById('gscount');
  let gmatches = [], gidx = -1;
  function centerNode(n) {
    const cx = parseFloat(n.dataset.cx) * zoom, cy = parseFloat(n.dataset.cy) * zoom;
    scroll.scrollTo({ left: cx - scroll.clientWidth / 2, top: cy - scroll.clientHeight / 2, behavior: 'smooth' });
  }
  function runSearch(q) {
    q = (q || '').trim().toLowerCase();
    gmatches = []; gidx = -1;
    if (!q) {
      for (const n of gnodes) n.classList.remove('nmatch', 'ndim');
      for (const p of edges) p.classList.remove('edim');
      gscount.textContent = ''; return;
    }
    for (const n of gnodes) {
      if (n.style.display === 'none') { n.classList.remove('nmatch', 'ndim'); continue; }
      const hit = (n.dataset.display || '').toLowerCase().includes(q) || (n.dataset.key || '').toLowerCase().includes(q);
      n.classList.toggle('nmatch', hit); n.classList.toggle('ndim', !hit);
      if (hit) gmatches.push(n);
    }
    const keys = new Set(gmatches.map(n => n.dataset.key));
    for (const p of edges) p.classList.toggle('edim', !(keys.has(p.dataset.from) && keys.has(p.dataset.to)));
    gscount.textContent = gmatches.length ? (gmatches.length + ' match' + (gmatches.length > 1 ? 'es' : '')) : 'no matches';
    if (gmatches.length) { gidx = 0; centerNode(gmatches[0]); }
  }
  if (gsearch) {
    gsearch.addEventListener('input', () => runSearch(gsearch.value));
    gsearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && gmatches.length) {
        e.preventDefault();
        gidx = (gidx + (e.shiftKey ? -1 : 1) + gmatches.length) % gmatches.length;
        centerNode(gmatches[gidx]); gscount.textContent = (gidx + 1) + '/' + gmatches.length;
      } else if (e.key === 'Escape') { gsearch.value = ''; runSearch(''); gsearch.blur(); }
    });
  }
  // Toggling a section re-renders server-side (lanes recompact around it).
  for (const c of document.querySelectorAll('.filt input')) {
    c.addEventListener('change', () => vscode.postMessage({ type: 'toggleSection', section: c.dataset.section, hidden: !c.checked }));
  }
  // "+ add" on a lane label creates a new entity in that section.
  for (const t of scroll.querySelectorAll('.laneadd')) {
    t.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'addEntity', section: t.dataset.section }); });
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
    { scripts: inj.scripts + inspectorFormScript(webview, nonce), imgCsp: inj.imgCsp }, initialView, amdToolbar('graph'));
}

// --- Story Outline: a scalable list/tree + focus-detail view over the SAME
// `amd/graph` model as the diagram. Where the diagram becomes a hairball past a
// localResourceRoots for a GUI Editor webview so it can load media/guiModel.js.
function mediaRoots(): vscode.Uri[] {
  return extensionUri ? [vscode.Uri.joinPath(extensionUri, 'media')] : [];
}

// --- GUI Editor: a structural composer that generates MAST -------------------
// Per MISSION_TOOLS_PLAN.md §4 (phase G1): a palette + design tree + properties
// panel that generate `gui_*` MAST into a marked region — the safe one-way author
// direction. Not a pixel canvas (that's a later phase); this composes the layout
// as a tree (like the Story Outline) and emits code you can see live. Codegen +
// parser live in the shared, unit-tested media/guiModel.js.
function guiEditorHtml(nonce: string, webview: vscode.Webview, docMode = false): string {
  const modelUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri!, 'media', 'guiModel.js'));
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin:0; display:flex; flex-direction:column; height:100vh; }
  .top { display:flex; gap:6px; align-items:center; padding:5px 10px; border-bottom:1px solid var(--vscode-panel-border,#8882); flex-wrap:wrap; }
  .top b { font-size:12px; }
  .top select { background: var(--vscode-button-secondaryBackground,#444); color: var(--vscode-button-secondaryForeground,#fff); border:none; border-radius:4px; padding:3px 6px; font-size:12px; cursor:pointer; }
  .cols { display:flex; flex:1; min-height:0; }
  .pal { width:150px; overflow:auto; border-right:1px solid var(--vscode-panel-border,#8883); padding:4px; }
  .pal .grp { font-size:10px; text-transform:uppercase; color:var(--vscode-descriptionForeground); margin:8px 4px 2px; }
  .pal button { display:block; width:100%; text-align:left; margin:2px 0; }
  .mid { flex:1; min-width:0; display:flex; flex-direction:column; border-right:1px solid var(--vscode-panel-border,#8883); }
  .tabs { display:flex; gap:2px; align-items:center; padding:4px 6px; border-bottom:1px solid var(--vscode-panel-border,#8882); }
  .tabs button.on { background: var(--vscode-button-background,#0a63c9); color:#fff; }
  .pane { flex:1; overflow:auto; padding:6px; }
  .pane.hidden { display:none; }
  pre#code { margin:0; font-family: var(--vscode-editor-font-family,monospace); font-size:12px; white-space:pre; }
  .right { width:300px; display:flex; flex-direction:column; }
  .tree-wrap { flex:1; display:flex; flex-direction:column; min-height:0; }
  #tree { flex:1; overflow:auto; padding:6px; }
  .props-wrap { height:46%; display:flex; flex-direction:column; min-height:0; border-top:1px solid var(--vscode-panel-border,#8883); }
  #props { flex:1; overflow:auto; padding:8px; }
  .rhdr { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--vscode-descriptionForeground); padding:5px 8px; border-bottom:1px solid var(--vscode-panel-border,#8882); background: var(--vscode-editorGroupHeader-tabsBackground, transparent); }
  button { background: var(--vscode-button-secondaryBackground,#444); color: var(--vscode-button-secondaryForeground,#fff); border:none; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:12px; }
  button.primary { background: var(--vscode-button-background,#0a63c9); color: var(--vscode-button-foreground,#fff); }
  .node { padding:2px 4px; border-radius:3px; cursor:pointer; white-space:nowrap; }
  .node:hover { background: var(--vscode-list-hoverBackground,#8881); }
  .node.sel { background: var(--vscode-list-activeSelectionBackground,#0a63c9); color:#fff; }
  .node[draggable=true] { cursor:grab; }
  .node.drop-into { outline:2px solid var(--vscode-focusBorder,#4ec9b0); outline-offset:-1px; }
  .node.drop-after { border-bottom:2px solid var(--vscode-focusBorder,#4ec9b0); }
  .node .ty { color: var(--vscode-symbolIcon-classForeground,#4ec9b0); }
  .node.sel .ty { color:#cff; }
  .node .lbl { color: var(--vscode-descriptionForeground); font-size:11px; }
  .node.sel .lbl { color:#dfe; }
  .kids { margin-left:14px; border-left:1px solid var(--vscode-panel-border,#8883); padding-left:4px; }
  .prow { margin:6px 0; }
  .prow label { display:block; font-size:11px; color:var(--vscode-descriptionForeground); margin-bottom:2px; }
  .prow input, .prow textarea { width:100%; box-sizing:border-box; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border,#8883); border-radius:3px; padding:3px 6px; font-family:inherit; font-size:12px; }
  .empty { color: var(--vscode-descriptionForeground); padding:8px; font-size:12px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .actions { display:flex; gap:4px; margin:6px 0; flex-wrap:wrap; }
  .actions button { font-size:11px; padding:2px 6px; }
  /* preview — mirrors the engine's flow layout: rows split a section's height,
     columns split a row's width, so a lone widget fills its whole section. */
  .pv-screen { position:relative; width:100%; aspect-ratio:16/9; background:#0b0f16; border:1px solid var(--vscode-panel-border,#8883); overflow:hidden; }
  .pv-sec { position:absolute; box-sizing:border-box; border:1px dashed #4ec9b077; padding:3px; overflow:hidden; display:flex; flex-direction:column; gap:3px; }
  .pv-sec.sel, .pv-w.sel, .pv-box.sel { outline:2px solid var(--vscode-focusBorder,#4ec9b0); outline-offset:-1px; }
  /* each flow row shares the section's height equally (like the engine's flex rows) */
  .pv-band, .pv-grid, .pv-box { flex:1 1 0; min-height:0; }
  .pv-band { display:flex; gap:3px; align-items:stretch; }
  .pv-w { display:flex; align-items:center; justify-content:center; text-align:center; box-sizing:border-box; border:1px solid #ffffff22; border-radius:2px; padding:2px 4px; font-size:10px; background:#18202e; color:#cde; flex:1 1 0; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; cursor:pointer; }
  .pv-w.btn { background:#294066; }
  .pv-w.face { background:#3a2a4a; }
  .pv-w.eng { background:#243b33; border-color:#4ec9b055; }
  .pv-w.engview { flex-direction:column; padding:2px; overflow:hidden; }
  .pv-svg { width:100%; height:100%; display:block; min-height:0; }
  .engview.view3d, .engview.radar { padding:0; background:#05070e; }
  .engview.shipdata, .engview.waterfall { align-items:stretch; justify-content:center; gap:3px; padding:5px; }
  .engview .pv-bar { height:5px; border-radius:2px; background:linear-gradient(90deg,#4ec9b0,#2b6); width:100%; }
  .engview .pv-line { height:3px; border-radius:2px; background:#7fb0c0aa; width:100%; }
  .engview.redalert { background:#4a1414; color:#f88; font-weight:600; letter-spacing:.08em; border-color:#f66; }
  .engview.zoom { flex-direction:row; gap:4px; font-size:11px; }
  .engview.zoom span { background:#1b2a3a; border-radius:3px; padding:0 5px; }
  .engview.named { color:#9bd; }
  .pv-w.chip { flex:0 0 auto; background:#2a2440; color:#bcd; font-size:10px; }
  .pv-grid { display:grid; gap:3px; grid-auto-rows:1fr; }
  .pv-box { display:flex; flex-direction:column; gap:2px; border:1px solid #4ec9b055; border-radius:3px; padding:3px; cursor:pointer; }
  .pv-cap { flex:0 0 auto; font-size:9px; color:#7fb0c0; text-transform:uppercase; letter-spacing:.04em; }
  .pv-row-sample { display:flex; gap:3px; flex:0 0 auto; }
  .pv-hand { position:absolute; right:-1px; bottom:-1px; width:12px; height:12px; background:var(--vscode-focusBorder,#4ec9b0); cursor:nwse-resize; z-index:3; }
  .pv-grip { position:absolute; left:-1px; top:-1px; width:14px; height:14px; background:#4ec9b0aa; cursor:move; z-index:3; }
</style></head><body>
<div class="top">
  <b>GUI Editor</b>
  <span class="muted">compose a layout → generate MAST</span>
  <span style="flex:1"></span>
  <button id="undo" title="Undo (Ctrl/Cmd-Z)">↶</button>
  <button id="redo" title="Redo (Ctrl/Cmd-Shift-Z)">↷</button>
  <button id="load" title="Load a # &lt;gui-designer&gt; block from the active .mast back into the editor">Load from file</button>
  <select id="tmpl" title="Start from a console screen template">
    <option value="">Template…</option>
    <option value="cinematic">Cinematic (full 3D)</option>
    <option value="cockpit">Cockpit (bg + views)</option>
    <option value="science">Science (3 columns)</option>
  </select>
  <button id="clear">New</button>
</div>
<div class="cols">
  <div class="pal" id="pal"></div>
  <div class="mid">
    <div class="tabs">
      <button id="tPreview" class="on">Preview</button>
      <button id="tCode" title="Code">Code</button>
      <span style="flex:1"></span>
      <button id="mock" title="Render this design for real in a running sbs debug mock session">Preview in mock</button>
      <button id="copy">Copy</button>
      <button id="insert" class="primary" title="Replace a # &lt;gui-designer&gt; … # &lt;/gui-designer&gt; block in the active .mast, or insert at the cursor">Insert into file</button>
    </div>
    <div id="preview" class="pane"></div>
    <div id="codepane" class="pane hidden"><pre id="code"></pre></div>
  </div>
  <div class="right">
    <div class="tree-wrap"><div class="rhdr">Layout tree</div><div id="tree"></div></div>
    <div class="props-wrap"><div class="rhdr">Inspector</div><div id="props"><div class="empty">Select an element to edit its properties.</div></div></div>
  </div>
</div>
<script nonce="${nonce}" src="${modelUri}"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const DOCMODE = ${docMode};                    // true = backing a .gui.mast file (two-way sync)
  let idc = 0, model = { id:0, type:'root', props:{ label:'my_gui' }, children: [] }, sel = null;
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // Element catalog + code-gen + parser come from the shared media/guiModel.js
  // (also unit-tested in Node). See top of file.
  const CAT = GuiModel.CAT;
  // Palette entries are a type name OR a preset object {t, label, props}.
  const PALETTE = [
    ['Containers', ['section','sub_section','row','grid','list','table']],
    ['Widgets', ['text','button','checkbox','slider','input','face','icon','image','blank',
                 'text_area','dropdown','int_slider','radio','icon_button']],
    ['Console views', [
      {t:'layout_widget', label:'3D View',        props:{widget:'3dview'}},
      {t:'layout_widget', label:'2D Radar',       props:{widget:'2dview'}},
      {t:'layout_widget', label:'Science 2D',     props:{widget:'science_2d_view'}},
      {t:'layout_widget', label:'Weapons 2D',     props:{widget:'weapon_2d_view'}},
      {t:'layout_widget', label:'Comms 2D',       props:{widget:'comms_2d_view'}},
      {t:'layout_widget', label:'Ship Data',      props:{widget:'ship_data'}},
      {t:'layout_widget', label:'Text Waterfall', props:{widget:'text_waterfall'}},
      {t:'layout_widget', label:'Radar Zoom',     props:{widget:'radar_zoom_ctrl'}},
      {t:'layout_widget', label:'Ship Internal',  props:{widget:'ship_internal_view'}},
      'ship',
      {t:'layout_widget', label:'Comms Control',  props:{widget:'comms_control'}},
      {t:'layout_widget', label:'Comms Face',     props:{widget:'comms_face'}},
      {t:'layout_widget', label:'Comms List',     props:{widget:'comms_sorted_list'}},
      {t:'layout_widget', label:'Red Alert',      props:{widget:'red_alert'}},
    ]],
    ['Console setup', ['console_preset','activate_console','cinematic']],
  ];

  function mk(type, over){ const c = CAT[type]; const n = { id:++idc, type, props: Object.assign({}, c.props||{}, over||{}) }; if (c.cont) n.children = []; return n; }
  function find(id, nodes, parent){ if (id===0) return {n:model, parent:null, list:null}; nodes = nodes || model.children; for (const n of nodes){ if (n.id===id) return {n, parent:parent||model, list:nodes}; if (n.children){ const r = find(id, n.children, n); if (r) return r; } } return null; }
  function selNode(){ return sel==null ? null : (find(sel)||{}).n; }

  // --- palette --- entries are a type string or a preset {t,label,props}; flatten
  // into a registry so a button can carry preset props by index.
  const REG = [];
  const pal = document.getElementById('pal');
  pal.innerHTML = PALETTE.map(function(g){
    return '<div class="grp">'+g[0]+'</div>' + g[1].map(function(e){
      const type = (typeof e === 'string') ? e : e.t;
      const label = (typeof e === 'string') ? CAT[type].label : e.label;
      const idx = REG.length; REG.push({ type: type, props: (typeof e === 'string') ? null : e.props });
      return '<button data-idx="'+idx+'" title="'+esc(type)+'">'+esc(label)+'</button>';
    }).join('');
  }).join('');
  pal.querySelectorAll('button[data-idx]').forEach(function(b){ b.onclick = function(){ addNode(REG[+b.dataset.idx]); }; });

  // Screen-level nodes (sections + console setup) live at the root; everything else
  // drops into the selected container (or as a sibling of a selected leaf).
  const ROOT_TYPES = { section:1, console_preset:1, activate_console:1, cinematic:1 };
  function addNode(item){
    const n = mk(item.type, item.props);
    if (ROOT_TYPES[item.type]){ model.children.push(n); }
    else {
      const s = selNode();
      if (s && s.children) { s.children.push(n); }
      else if (s) { const r = find(sel); (r.list||model.children).push(n); }
      else { model.children.push(n); }
    }
    sel = n.id; recordHistory(); render();
  }

  // --- console screen templates (match the real LM skeletons) ---
  function box(area, widget){ const s = mk('section', {area:area}); s.children.push(mk('layout_widget', {widget:widget})); return s; }
  function col(area, widgets){ const s = mk('section', {area:area}); widgets.forEach(function(w){ s.children.push(mk('layout_widget', {widget:w})); }); return s; }
  const TEMPLATES = {
    cinematic: function(){ const s = mk('section', {area:'0,0,100,100'}); s.children.push(mk('layout_widget', {widget:'3dview'}));
      return [s, mk('activate_console', {name:'cinematic'}), mk('cinematic', {mode:'auto'})]; },
    cockpit: function(){ const bg = mk('section', {area:'0,0,100,100'}); bg.children.push(mk('image', {props:'cockpit_overlay', style:''}));
      return [mk('activate_console', {name:'cockpit'}), bg,
        box('0,11,100,100','3dview'), box('20,72,37.5,99','2dview'), box('88,50,100,100','ship_data'), box('41,90,60,99','text_waterfall')]; },
    science: function(){ return [col('0,0,30,100', []), col('30,0,72,100', ['science_2d_view']),
        col('72,0,100,100', ['science_data_tabs','science_data_freq','science_data','science_sorted_list'])]; },
  };
  const tmplSel = document.getElementById('tmpl');
  tmplSel.onchange = function(){ const k = tmplSel.value; tmplSel.value = '';
    if (TEMPLATES[k]){ model.children = TEMPLATES[k](); sel = null; recordHistory(); render(); } };

  // --- render: preview + code (middle tabs), tree + inspector (right) ---
  function render(){ renderPreview(); renderTree(); renderProps(); renderCode(); if (DOCMODE) maybeSync(); }
  // In file mode, push generated MAST back to the document when it actually
  // changes (debounced). lastSent guards the loop: receiving an 'update' sets it,
  // so re-rendering doesn't echo the change back.
  let lastSent = null, syncTimer = null, loaded = false;
  function maybeSync(){
    if (!loaded) return;                          // don't write until the document has loaded (avoids clearing it on open)
    const c = code(); clearTimeout(syncTimer);
    if (c === lastSent) return;
    syncTimer = setTimeout(function(){ lastSent = c; vscode.postMessage({ type:'apply', code: c }); }, 250);
  }

  // --- undo / redo (model snapshots) ---
  let history = [], hIndex = -1, histTimer = null;
  function resetHistory(){ history = [JSON.stringify(model)]; hIndex = 0; }
  function recordHistory(){                        // call after a mutation
    const snap = JSON.stringify(model);
    if (history[hIndex] === snap) return;          // no-op (e.g. a click that didn't move)
    history = history.slice(0, hIndex + 1);
    history.push(snap);
    if (history.length > 200) history.shift();
    hIndex = history.length - 1;
  }
  function recordHistorySoon(){ clearTimeout(histTimer); histTimer = setTimeout(recordHistory, 350); }  // coalesce prop typing
  function restore(i){ hIndex = i; model = JSON.parse(history[i]); sel = null; render(); }
  function undo(){ clearTimeout(histTimer); if (hIndex > 0) restore(hIndex - 1); }
  function redo(){ clearTimeout(histTimer); if (hIndex < history.length - 1) restore(hIndex + 1); }
  document.getElementById('undo').onclick = undo;
  document.getElementById('redo').onclick = redo;
  document.addEventListener('keydown', function(e){
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });
  // Middle tabs switch Preview vs Code; the tree lives on the right, always shown.
  function pickTab(t){
    document.getElementById('preview').classList.toggle('hidden', t!=='preview');
    document.getElementById('codepane').classList.toggle('hidden', t!=='code');
    document.getElementById('tPreview').classList.toggle('on', t==='preview');
    document.getElementById('tCode').classList.toggle('on', t==='code');
  }
  document.getElementById('tPreview').onclick = function(){ pickTab('preview'); };
  document.getElementById('tCode').onclick = function(){ pickTab('code'); };

  function bindPicks(root){ root.querySelectorAll('[data-id]').forEach(function(el){ el.onclick = function(ev){ ev.stopPropagation(); sel = +el.dataset.id; render(); }; }); }

  function renderTree(){
    const t = document.getElementById('tree');
    t.innerHTML = nodeHtml(model);                                     // always show the root
    t.querySelectorAll('.node').forEach(function(el){
      const id = +el.dataset.id;
      el.onclick = function(ev){ ev.stopPropagation(); sel = id; render(); };
      // Drag to move: onto a container = into it; onto a leaf = after it. Root
      // isn't draggable, but is a drop target (into = top level).
      el.draggable = (id !== 0);
      el.ondragstart = function(ev){ ev.dataTransfer.setData('text/plain', String(id)); ev.dataTransfer.effectAllowed='move'; ev.stopPropagation(); };
      el.ondragover = function(ev){ ev.preventDefault(); ev.stopPropagation();
        el.classList.remove('drop-into','drop-after');
        el.classList.add(selNodeById(id) && selNodeById(id).children ? 'drop-into' : 'drop-after'); };
      el.ondragleave = function(){ el.classList.remove('drop-into','drop-after'); };
      el.ondrop = function(ev){ ev.preventDefault(); ev.stopPropagation(); el.classList.remove('drop-into','drop-after');
        moveNode(+ev.dataTransfer.getData('text/plain'), id); };
    });
  }
  function selNodeById(id){ const r = find(id); return r ? r.n : null; }
  function isDescendant(ancestorId, nodeId){
    const r = find(ancestorId); if (!r || !r.n.children) return false;
    function walk(ns){ for (const n of ns){ if (n.id===nodeId) return true; if (n.children && walk(n.children)) return true; } return false; }
    return walk(r.n.children);
  }
  function moveNode(dragId, targetId){
    if (dragId===targetId || dragId===0 || isDescendant(dragId, targetId)) return;   // no self / root / into-own-child
    const dr = find(dragId); if (!dr || !dr.list) return;
    const node = dr.n;
    // A section may only live at root level — redirect any drop to the top.
    if (node.type==='section'){
      const tr0 = find(targetId);
      dr.list.splice(dr.list.indexOf(node), 1);
      if (tr0 && tr0.n.type==='section'){ model.children.splice(model.children.indexOf(tr0.n)+1, 0, node); }
      else { model.children.push(node); }
      sel = dragId; recordHistory(); render(); return;
    }
    dr.list.splice(dr.list.indexOf(node), 1);
    const tr = find(targetId);
    if (!tr) { model.children.push(node); }
    else if (tr.n.children) { tr.n.children.push(node); }              // into container (incl root)
    else { tr.list.splice(tr.list.indexOf(tr.n)+1, 0, node); }         // after leaf
    sel = dragId; recordHistory(); render();
  }

  // Approximate spatial preview: sections positioned by their area, contents
  // laid out roughly the way MAST flows them. Not pixel-faithful (a later phase),
  // but shows where things sit. Click any box to select it.
  function renderPreview(){
    const t = document.getElementById('preview');
    if (!model.children.length) { t.innerHTML = '<div class="empty">Add a Section, then drop widgets in. The preview shows roughly where things land.</div>'; return; }
    const secs = model.children.filter(function(n){ return n.type==='section'; });
    const loose = model.children.filter(function(n){ return n.type!=='section'; });
    let inner = secs.map(pvSection).join('');
    if (loose.length) inner += pvSection({ id:-1, type:'section', props:{area:'0,0,100,100'}, children:loose });
    t.innerHTML = '<div class="pv-screen">'+inner+'</div>';
    bindPicks(t);
    // Sized sections get move (top-left grip) + resize (bottom-right) handles.
    t.querySelectorAll('[data-move]').forEach(function(h){ h.onmousedown = function(ev){ beginSecDrag(ev, +h.dataset.move, 'move'); }; });
    t.querySelectorAll('[data-resize]').forEach(function(h){ h.onmousedown = function(ev){ beginSecDrag(ev, +h.dataset.resize, 'resize'); }; });
  }
  function pvSection(n){
    const a = (n.props.area||'0,0,100,100').split(',').map(function(x){ return parseFloat(x)||0; });
    const l=a[0]||0, tp=a[1]||0, r=(a[2]==null?100:a[2]), b=(a[3]==null?100:a[3]);
    let st = 'left:'+l+'%;top:'+tp+'%;width:'+Math.max(0,r-l)+'%;height:'+Math.max(0,b-tp)+'%;';
    const bg = (n.props.style||'').match(/background(?:_color)?\\s*:\\s*([^;]+)/);   // show a section's background
    if (bg) st += 'background:'+bg[1].trim()+';';
    const handles = n.id>=0 ? '<div class="pv-grip" data-move="'+n.id+'" title="Move section"></div><div class="pv-hand" data-resize="'+n.id+'" title="Resize section"></div>' : '';
    return '<div class="pv-sec'+(n.id===sel?' sel':'')+'" data-id="'+n.id+'" style="'+st+'">'+handles+pvFlow(n.children||[])+'</div>';
  }
  // Drag a section on the preview to move/resize it; writes back to props.area live.
  let secDrag = null;
  function beginSecDrag(ev, id, mode){
    ev.preventDefault(); ev.stopPropagation();
    const n = selNodeById(id); if (!n) return;
    const a = (n.props.area||'0,0,100,100').split(',').map(function(x){ return parseFloat(x)||0; });
    const screen = document.querySelector('.pv-screen');
    secDrag = { id, mode, sx:ev.clientX, sy:ev.clientY, orig:a, rect: screen ? screen.getBoundingClientRect() : null };
    sel = id;
    window.addEventListener('mousemove', onSecDrag);
    window.addEventListener('mouseup', endSecDrag);
  }
  function clampN(v,a,b){ return Math.max(a, Math.min(b, v)); }
  function round1(v){ return Math.round(v*10)/10; }
  function onSecDrag(ev){
    if (!secDrag || !secDrag.rect) return;
    const dx = (ev.clientX-secDrag.sx)/secDrag.rect.width*100;
    const dy = (ev.clientY-secDrag.sy)/secDrag.rect.height*100;
    let l=secDrag.orig[0], tp=secDrag.orig[1], r=secDrag.orig[2], b=secDrag.orig[3];
    if (secDrag.mode==='move'){ const w=r-l, h=b-tp; l=clampN(l+dx,0,100-w); tp=clampN(tp+dy,0,100-h); r=l+w; b=tp+h; }
    else { r=clampN(r+dx, l+3, 100); b=clampN(b+dy, tp+3, 100); }
    const n = selNodeById(secDrag.id); if (!n) return;
    n.props.area = [round1(l),round1(tp),round1(r),round1(b)].join(',');
    renderPreview(); renderCode(); renderProps();
  }
  function endSecDrag(){ window.removeEventListener('mousemove', onSecDrag); window.removeEventListener('mouseup', endSecDrag); secDrag = null; recordHistory(); }
  function pvFlow(nodes){
    let out=''; let band=[];
    function flush(){ if (band.length){ out += '<div class="pv-band">'+band.join('')+'</div>'; band=[]; } }
    for (const n of nodes){
      if (n.type==='row'){ flush(); out += '<div class="pv-band" data-id="'+n.id+'">'+(n.children||[]).map(pvWidget).join('')+'</div>'; }
      else if (n.type==='grid'){ flush(); const cols=Math.max(1,parseInt(n.props.columns)||1);
        out += '<div class="pv-grid'+(n.id===sel?' sel':'')+'" data-id="'+n.id+'" style="grid-template-columns:repeat('+cols+',1fr);">'+(n.children||[]).map(pvWidget).join('')+'</div>'; }
      else if (n.type==='list'){ flush(); out += pvList(n); }
      else if (n.type==='table'){ flush(); out += pvTable(n); }
      else if (n.type==='sub_section'){ flush(); out += '<div class="pv-box'+(n.id===sel?' sel':'')+'" data-id="'+n.id+'"><div class="pv-cap">sub-section</div>'+pvFlow(n.children||[])+'</div>'; }
      else { band.push(pvWidget(n)); }
    }
    flush();
    return out;
  }
  function pvList(n){
    const rowKids = (n.children||[]).map(pvWidget).join('');
    let s = '<div class="pv-box'+(n.id===sel?' sel':'')+'" data-id="'+n.id+'"><div class="pv-cap">list · '+esc(n.props.items||'')+'</div>';
    for (let i=0;i<3;i++){ s += '<div class="pv-row-sample">'+(rowKids||'<span class="pv-w">row…</span>')+'</div>'; }
    return s+'</div>';
  }
  function pvBox(n, cap){ return '<div class="pv-box'+(n.id===sel?' sel':'')+'" data-id="'+n.id+'"><div class="pv-cap">'+cap+'</div></div>'; }
  function pvTable(n){
    const cells = (n.children||[]).map(pvWidget).join('');
    const heads = (n.props.headers||'').split(',').map(function(h){ return h.trim(); }).filter(Boolean)
      .map(function(h){ return '<span class="pv-w" style="color:#8ab;text-align:center;">'+esc(h)+'</span>'; }).join('');
    let s = '<div class="pv-box'+(n.id===sel?' sel':'')+'" data-id="'+n.id+'"><div class="pv-cap">table · '+esc(n.props.items||'')+'</div>';
    if (heads) s += '<div class="pv-row-sample">'+heads+'</div>';
    for (let i=0;i<2;i++){ s += '<div class="pv-row-sample">'+(cells||'<span class="pv-w">row…</span>')+'</div>'; }
    return s+'</div>';
  }
  // Engine console widgets get recognizable placeholders (they fill their section).
  function pvEngine(n){
    const w = (n.props&&n.props.widget)||''; const s = n.id===sel?' sel':'';
    const radar = '<svg class="pv-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">'
      + '<circle cx="50" cy="50" r="46" fill="none" stroke="#3c8" stroke-opacity=".55"/>'
      + '<circle cx="50" cy="50" r="30" fill="none" stroke="#3c8" stroke-dasharray="2 3" stroke-opacity=".4"/>'
      + '<circle cx="50" cy="50" r="15" fill="none" stroke="#3c8" stroke-dasharray="2 3" stroke-opacity=".4"/>'
      + '<line x1="50" y1="4" x2="50" y2="96" stroke="#3c8" stroke-opacity=".2"/><line x1="4" y1="50" x2="96" y2="50" stroke="#3c8" stroke-opacity=".2"/>'
      + '<circle cx="62" cy="40" r="2.6" fill="#e66"/><circle cx="41" cy="61" r="2.6" fill="#5cf"/></svg>';
    const view3d = '<svg class="pv-svg" viewBox="0 0 100 60" preserveAspectRatio="xMidYMid slice">'
      + '<rect width="100" height="60" fill="#05070e"/>'
      + '<g fill="#fff" fill-opacity=".75"><circle cx="12" cy="12" r=".6"/><circle cx="82" cy="18" r=".6"/><circle cx="30" cy="46" r=".6"/><circle cx="66" cy="40" r=".6"/><circle cx="50" cy="8" r=".5"/></g>'
      + '<polygon points="50,24 59,39 41,39" fill="#8ab" stroke="#cde" stroke-width=".7"/></svg>';
    let inner, cls;
    if (w==='3dview'){ cls='view3d'; inner=view3d; }
    else if (/2d_?view$|^2dview$|radar/.test(w)){ cls='radar'; inner=radar; }
    else if (w==='ship_data'){ cls='shipdata'; inner='<div class="pv-bar"></div><div class="pv-bar" style="width:62%"></div><div class="pv-bar" style="width:80%"></div>'; }
    else if (w==='text_waterfall'){ cls='waterfall'; inner='<div class="pv-line"></div><div class="pv-line" style="width:72%"></div><div class="pv-line" style="width:86%"></div>'; }
    else if (w==='red_alert'){ cls='redalert'; inner='RED ALERT'; }
    else if (w==='radar_zoom_ctrl'){ cls='zoom'; inner='<span>−</span><span>+</span><span>SIDE</span>'; }
    else if (/^comms/.test(w)){ cls='comms'; inner='<div class="pv-cap">'+esc(w.replace(/_/g,' '))+'</div>'; }
    else { cls='named'; inner='<span>⚙ '+esc(w)+'</span>'; }
    return '<div class="pv-w eng engview '+cls+s+'" data-id="'+n.id+'" title="'+esc(w)+'">'+inner+'</div>';
  }
  function pvWidget(n){
    if (n.type==='layout_widget') return pvEngine(n);
    if (n.type==='console_preset') return '<div class="pv-w eng engview named'+(n.id===sel?' sel':'')+'" data-id="'+n.id+'" title="gui_console"><span>🖥 console: '+esc((n.props&&n.props.console)||'')+'</span></div>';
    if (n.type==='activate_console') return '<span class="pv-w chip'+(n.id===sel?' sel':'')+'" data-id="'+n.id+'" title="gui_activate_console">activate: '+esc((n.props&&n.props.name)||'')+'</span>';
    if (n.type==='cinematic') return '<span class="pv-w chip'+(n.id===sel?' sel':'')+'" data-id="'+n.id+'" title="cinematic camera">🎥 '+esc((n.props&&n.props.mode)||'auto')+'</span>';
    const ENG = ['ship','text_area','dropdown','int_slider','radio','icon_button'];
    let cls = (n.type==='button'||n.type==='icon_button') ? ' btn' : (n.type==='face' ? ' face' : '');
    if (ENG.indexOf(n.type)>=0) cls += ' eng';
    const p = n.props||{};
    let label = summary(n) || n.type;
    if (n.type==='face') label = 'face';
    if (n.type==='blank') label = '·';
    if (n.type==='ship') label = '⛛ '+(p.props||'ship');
    if (n.type==='text_area') label = (p.text||'text').split('\\n')[0];
    if (n.type==='dropdown') label = (p.items||'').replace(/^items:/,'').split(',')[0]+' ▾';
    if (n.type==='radio') label = '◉ '+(p.items||'').replace(/^items:/,'');
    if (n.type==='int_slider') label = '●──────';
    if (n.type==='icon_button') label = '▣';
    return '<span class="pv-w'+cls+(n.id===sel?' sel':'')+'" data-id="'+n.id+'" title="'+esc(CAT[n.type]?CAT[n.type].label:n.type)+'">'+esc(label)+'</span>';
  }
  function nodeHtml(n){
    const c = CAT[n.type];
    const lbl = summary(n);
    let h = '<div class="node'+(n.id===sel?' sel':'')+'" data-id="'+n.id+'"><span class="ty">'+c.label+'</span> <span class="lbl">'+esc(lbl)+'</span></div>';
    if (n.children) h += '<div class="kids">'+ (n.children.length ? n.children.map(nodeHtml).join('') : '<div class="empty">empty</div>') +'</div>';
    return h;
  }
  function summary(n){ const p=n.props||{};
    switch(n.type){
      case 'root': return model.children.length + ' section(s)';
      case 'section': return p.area; case 'row': return p.style||''; case 'sub_section': return p.style||'';
      case 'grid': return p.columns+' cols'; case 'list': return p.items+' as '+(p.as||'item');
      case 'text': return p.text; case 'button': return p.text; case 'input': return p.var; case 'face': return p.var;
      case 'blank': return p.count; case 'table': return p.items; case 'raw': return p.line;
      case 'text_area': return p.text; case 'ship': return p.props;
      case 'dropdown': case 'radio': return (p.items||'')+' → '+(p.var||'');
      case 'int_slider': return (p.props||'')+' → '+(p.var||'');
      case 'layout_widget': return p.widget; case 'console_preset': return 'console: '+(p.console||'');
      case 'activate_console': return 'activate '+(p.name||''); case 'cinematic': return 'camera: '+(p.mode||'auto');
      default: return p.props||'';
    }
  }

  // --- properties ---
  function renderProps(){
    const box = document.getElementById('props'); const n = selNode();
    if (!n) { box.innerHTML = '<div class="empty">Select an element to edit its properties.</div>'; return; }
    const c = CAT[n.type] || { label:n.type, fields:[] };
    if (n.type==='root'){
      box.innerHTML = '<div class="prow"><b>Screen</b></div>'
        + '<div class="prow"><label>Label name</label><input data-k="label" value="'+esc((n.props&&n.props.label)||'my_gui')+'"></div>'
        + '<div class="muted" style="padding:4px 0">The gui is written under <b>=== '+esc((n.props&&n.props.label)||'my_gui')+'</b> and ends with await gui(). Sections live under it.</div>';
      const inp = box.querySelector('[data-k]');
      inp.oninput = function(){ n.props.label = inp.value; renderCode(); recordHistorySoon(); };
      return;
    }
    let h = '<div class="prow"><b>'+c.label+'</b></div>';
    h += '<div class="actions">'
       + '<button data-act="up">↑</button><button data-act="down">↓</button>'
       + '<button data-act="del">Delete</button></div>';
    h += (c.fields||[]).map(function(f){
      const key=f[0], label=f[1], val=n.props[key]==null?'':n.props[key];
      const big = (key==='columns');
      return '<div class="prow"><label>'+esc(label)+'</label>'
        + (big ? '<textarea rows="3" data-k="'+key+'">'+esc(val)+'</textarea>'
               : '<input data-k="'+key+'" value="'+esc(val)+'">')+'</div>';
    }).join('');
    box.innerHTML = h;
    box.querySelectorAll('[data-k]').forEach(function(inp){ inp.oninput = function(){ n.props[inp.dataset.k] = inp.value; renderTree(); renderPreview(); renderCode(); recordHistorySoon(); }; });
    box.querySelectorAll('[data-act]').forEach(function(b){ b.onclick = function(){ act(b.dataset.act); }; });
  }
  function act(a){
    const r = find(sel); if (!r || !r.list) return;                   // root has no list
    const i = r.list.indexOf(r.n);
    if (a==='del'){ r.list.splice(i,1); sel=null; }
    else if (a==='up' && i>0){ r.list.splice(i,1); r.list.splice(i-1,0,r.n); }
    else if (a==='down' && i<r.list.length-1){ r.list.splice(i,1); r.list.splice(i+1,0,r.n); }
    render();
  }

  // --- code generation (model -> MAST) via the shared module ---
  function code(){ return GuiModel.generate(model); }             // '' when empty — never emits a placeholder
  function renderCode(){ const c = code(); document.getElementById('code').textContent = c || '# (nothing yet)'; }

  document.getElementById('copy').onclick = function(){ vscode.postMessage({ type:'copy', code: code() }); };
  document.getElementById('insert').onclick = function(){ vscode.postMessage({ type:'insert', code: code() }); };
  document.getElementById('mock').onclick = function(){ vscode.postMessage({ type:'mockPreview', code: code() }); };
  document.getElementById('load').onclick = function(){ vscode.postMessage({ type:'loadRequest' }); };
  document.getElementById('clear').onclick = function(){ model = { id:0, type:'root', props:{ label:'my_gui' }, children: [] }; sel = null; recordHistory(); render(); };

  // --- round-trip: parse the editor's own generated block back into the model
  //     (shared media/guiModel.js). Unrecognised lines become 'raw' and re-emit
  //     verbatim; a known element's full style string is kept. ---
  function loadFromCode(codeText){
    const r = GuiModel.parse(codeText);
    model = r.model; idc = r.nextId; sel = null; resetHistory();
    if (DOCMODE) { lastSent = code(); loaded = true; }   // now safe to sync; opening must not rewrite the file
    render();
  }
  window.addEventListener('message', function(e){ const m = e.data; if (!m) return;
    if (m.type==='loadBlock') { loadFromCode(m.code); }
    else if (m.type==='update') {
      // Ignore the document echoing back our own just-applied edit (keeps selection).
      if (lastSent != null && String(m.code).trim() === String(lastSent).trim()) return;
      loadFromCode(m.code);
    }
  });

  if (DOCMODE) {
    // The document is the source of truth; hide the marked-region / new actions.
    ['load','insert','clear'].forEach(function(idv){ const el = document.getElementById(idv); if (el) el.style.display='none'; });
    // In file mode the raw text IS the code, so the Code tab opens the full text
    // editor instead of an in-webview pane.
    const tc = document.getElementById('tCode'); tc.title = 'Open the full text editor';
    tc.onclick = function(){ vscode.postMessage({ type:'openText' }); };
    vscode.postMessage({ type:'ready' });          // ask the provider for the current document text
  }
  resetHistory();                                  // seed undo baseline (loadFromCode re-seeds when a doc loads)
  render();
</script></body></html>`;
}

// The mission folder a file lives in (nearest ancestor with description.yaml),
// else its workspace folder.
function missionDirForUri(uri?: vscode.Uri): string | undefined {
  if (!uri) { return undefined; }
  let dir = path.dirname(uri.fsPath);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'description.yaml'))) { return dir; }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
}

// Mocks the extension started for previewing, keyed by port (reused across
// clicks; the runner self-cleans a stale singleton on the same port).
const mockRunners = new Map<number, cp.ChildProcess>();
// Ports where we've already opened the /web/gui_preview browser tab this session.
const previewOpened = new Set<number>();

// Ensure a mock is listening on `port`, starting `sbs debug <mission>` if not.
async function ensureMockRunning(missionDir: string, port: number): Promise<boolean> {
  try { await waitForPort('127.0.0.1', port, 600); return true; } catch { /* not up yet */ }
  const existing = mockRunners.get(port);
  if (!existing || existing.exitCode !== null) {
    const base = resolveSbsBase();
    const args = [...base.args, 'debug', missionDir, '--port', String(port), '--use-working-tree'];
    output.show(true);
    output.appendLine(`Starting mock for preview: ${base.command} ${args.join(' ')}`);
    const child = cp.spawn(base.command, args, { cwd: base.cwd, windowsHide: true });
    child.stdout?.on('data', (d: Buffer) => output.append(d.toString()));
    child.stderr?.on('data', (d: Buffer) => output.append(d.toString()));
    child.on('exit', () => { mockRunners.delete(port); previewOpened.delete(port); });
    mockRunners.set(port, child);
    previewOpened.delete(port);   // fresh mock → its preview tab needs (re)opening
  }
  try { await waitForPort('127.0.0.1', port, 60000); return true; } catch { return false; }
}

// Render the editor's current design for real in a running `sbs debug` mock (the
// pixel-faithful preview): store the design, then open (once) the dedicated
// /web/gui_preview browser page that renders it as its own gui. Starts a mock for
// the file's own mission if none is listening.
async function guiEditorMockPreview(code: string, missionDir?: string): Promise<void> {
  const port = vscode.workspace.getConfiguration('amd').get<number>('sessionPort', 8765);
  const post = () => postDebugCommand(port, { action: 'gui_preview', code });

  let stored = false;
  try { await post(); stored = true; } catch { /* nothing listening — start a mock */ }

  if (!stored) {
    if (!missionDir) {
      vscode.window.showWarningMessage(`GUI Editor: no running mock on port ${port}, and no mission folder found for this file to start one.`);
      return;
    }
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting mock for ${path.basename(missionDir)}…` },
      () => ensureMockRunning(missionDir, port));
    if (!ok) { vscode.window.showWarningMessage(`GUI Editor: could not start a mock on port ${port}.`); return; }
    for (let i = 0; i < 12 && !stored; i++) {
      try { await post(); stored = true; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    if (!stored) { vscode.window.showWarningMessage('GUI Editor: mock started, but storing the preview failed — try again in a moment.'); return; }
  }

  // Open the preview page once per mock; re-previews re-render in the open tab.
  if (!previewOpened.has(port)) {
    void vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}/web/gui_preview`));
    previewOpened.add(port);
  }
  vscode.window.setStatusBarMessage('$(broadcast) Previewed design in mock', 3000);
}

async function showGuiEditor(): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'amdGuiEditor', 'GUI Editor', vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: mediaRoots() });
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  panel.webview.html = guiEditorHtml(nonce, panel.webview);
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === 'copy') {
      await vscode.env.clipboard.writeText(msg.code || '');
      vscode.window.showInformationMessage('GUI Editor: MAST copied to clipboard.');
    } else if (msg?.type === 'insert') {
      await insertGeneratedGui(msg.code || '');
    } else if (msg?.type === 'mockPreview') {
      const md = missionDirForUri(vscode.window.activeTextEditor?.document.uri
        || vscode.workspace.workspaceFolders?.[0]?.uri);
      await guiEditorMockPreview(msg.code || '', md);
    } else if (msg?.type === 'loadRequest') {
      const block = readDesignerBlock();
      if (block == null) {
        vscode.window.showWarningMessage('GUI Editor: no # <gui-designer> block found in the active .mast.');
      } else {
        panel.webview.postMessage({ type: 'loadBlock', code: block });
        vscode.window.showInformationMessage('GUI Editor: loaded the designer block.');
      }
    }
  });
}

// Extract the body between `# <gui-designer>` and `# </gui-designer>` in the
// active .mast (null if there's no such block) — the source for round-trip load.
function readDesignerBlock(): string | null {
  const ed = vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'mast')
    || vscode.window.activeTextEditor;
  if (!ed) { return null; }
  const text = ed.document.getText();
  const begin = '# <gui-designer>';
  const end = '# </gui-designer>';
  const bi = text.indexOf(begin);
  const ei = text.indexOf(end);
  if (bi < 0 || ei < 0 || ei < bi) { return null; }
  return text.slice(bi + begin.length, ei).replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

// Custom editor for *.gui.mast: the whole file IS the design, so opening one
// shows the GUI Editor. Two-way synced — the document is the source of truth
// (parse text → model), and model edits regenerate the whole document.
class GuiFileEditorProvider implements vscode.CustomTextEditorProvider {
  public static register(): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider('amd.guiFileEditor', new GuiFileEditorProvider(),
      { webviewOptions: { retainContextWhenHidden: true } });
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: mediaRoots() };
    const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
    panel.webview.html = guiEditorHtml(nonce, panel.webview, true);

    let writing = false;   // suppress the change we cause ourselves
    const update = () => { void panel.webview.postMessage({ type: 'update', code: document.getText() }); };
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString() && !writing) { update(); }
    });
    panel.onDidDispose(() => sub.dispose());

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') { update(); }                       // webview loaded → send current text
      else if (msg?.type === 'copy') { await vscode.env.clipboard.writeText(msg.code || ''); }
      else if (msg?.type === 'mockPreview') { await guiEditorMockPreview(msg.code || '', missionDirForUri(document.uri)); }
      else if (msg?.type === 'openText') {                           // toggle to the full text editor
        await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      }
      else if (msg?.type === 'apply') {
        writing = true;
        try {
          const edit = new vscode.WorkspaceEdit();
          const text = (msg.code || '');
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0),
            text.endsWith('\n') ? text : text + '\n');
          await vscode.workspace.applyEdit(edit);
        } finally { writing = false; }
      }
    });
  }
}

// Replace a `# <gui-designer> … # </gui-designer>` block in the active .mast
// (regenerating only what the editor owns), or insert at the cursor if there's
// no such block — the safe marked-region strategy from the plan.
async function insertGeneratedGui(code: string): Promise<void> {
  const ed = vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'mast')
    || vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showWarningMessage('GUI Editor: open a .mast file to insert into.'); return; }
  const doc = ed.document;
  const text = doc.getText();
  const begin = '# <gui-designer>';
  const end = '# </gui-designer>';
  const bi = text.indexOf(begin);
  const ei = text.indexOf(end);
  const block = begin + '\n' + code + '\n' + end;
  await ed.edit((b) => {
    if (bi >= 0 && ei > bi) {
      b.replace(new vscode.Range(doc.positionAt(bi), doc.positionAt(ei + end.length)), block);
    } else {
      b.insert(ed.selection.active, block + '\n');
    }
  });
  vscode.window.showInformationMessage(bi >= 0 ? 'GUI Editor: updated the designer block.' : 'GUI Editor: inserted at the cursor.');
}

// few dozen nodes, this never renders the whole graph — you navigate it: a
// searchable/filterable outline on the left, and the selected node's direct
// incoming/outgoing connections (each a clickable chip) on the right. See
// MISSION_TOOLS_PLAN.md §3.5.1.
function storyOutlineHtml(graph: MissionGraph, nonce: string, webview: vscode.Webview, selectedKey?: string): string {
  const data = JSON.stringify(graph).replace(/</g, '\\u003c');
  const inj = faceInjection(webview, nonce);
  const preselect = selectedKey ? JSON.stringify(selectedKey) : 'null';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${inj.imgCsp} style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin:0; display:flex; flex-direction:column; height:100vh; }
  .top { display:flex; gap:6px; align-items:center; padding:6px 10px; border-bottom:1px solid var(--vscode-panel-border,#8882); }
  .top input[type=search] { flex:1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border,#8883); border-radius:4px; padding:3px 8px; font-size:12px; }
  .filters { display:flex; gap:8px; padding:3px 10px; flex-wrap:wrap; border-bottom:1px solid var(--vscode-panel-border,#8882); font-size:11px; color:var(--vscode-descriptionForeground); }
  .filters label { cursor:pointer; user-select:none; }
  .split { display:flex; flex:1; min-height:0; }
  .list { width:42%; min-width:220px; overflow:auto; border-right:1px solid var(--vscode-panel-border,#8883); }
  .detail { flex:1; overflow:auto; padding:8px 12px; }
  .sec { padding:4px 10px 2px; font-size:11px; text-transform:uppercase; color:var(--vscode-descriptionForeground); position:sticky; top:0; background:var(--vscode-editor-background); display:flex; align-items:center; gap:6px; }
  .addbtn { margin-left:auto; cursor:pointer; border:1px solid var(--vscode-panel-border,#8884); border-radius:3px; padding:0 6px; line-height:16px; color:var(--vscode-descriptionForeground); }
  .addbtn:hover { color:var(--vscode-foreground); border-color:var(--vscode-focusBorder,#4ec9b0); background:var(--vscode-list-hoverBackground,#8881); }
  .row { padding:2px 10px 2px 20px; font-size:13px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border-left:2px solid transparent; }
  .row:hover { background: var(--vscode-list-hoverBackground,#8881); }
  .row.sel { background: var(--vscode-list-activeSelectionBackground,#0a63c9); color: var(--vscode-list-activeSelectionForeground,#fff); border-left-color: var(--vscode-focusBorder,#4ec9b0); }
  .row .k { color: var(--vscode-descriptionForeground); font-size:11px; }
  .row.sel .k { color: inherit; }
  .badge { font-size:10px; border-radius:6px; padding:0 5px; margin-left:4px; }
  .badge.err { background: var(--vscode-inputValidation-errorBackground,#5a1d1d); color:#f88; }
  .badge.warn { background: var(--vscode-inputValidation-warningBackground,#5a4a1d); color:#fc8; }
  .dtitle { font-size:16px; font-weight:600; margin:0 0 2px; }
  .dkey { color: var(--vscode-descriptionForeground); font-size:12px; font-family: var(--vscode-editor-font-family); }
  .dactions { margin:6px 0 12px; display:flex; gap:6px; }
  .grp { margin:10px 0 4px; font-size:11px; text-transform:uppercase; color:var(--vscode-descriptionForeground); }
  .chip { display:inline-flex; align-items:center; gap:6px; margin:2px 4px 2px 0; padding:2px 8px; border-radius:12px; font-size:12px; cursor:pointer; background: var(--vscode-badge-background,#333); color: var(--vscode-badge-foreground,#eee); }
  .chip:hover { outline:1px solid var(--vscode-focusBorder,#4ec9b0); }
  .chip .ek { color: var(--vscode-symbolIcon-eventForeground,#c586c0); font-size:10px; text-transform:uppercase; }
  .src { color: var(--vscode-textLink-foreground,#4daafc); font-size:11px; cursor:pointer; margin-left:6px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .empty { padding:10px; color: var(--vscode-descriptionForeground); }
  button { background: var(--vscode-button-secondaryBackground,#444); color: var(--vscode-button-secondaryForeground,#fff); border:none; border-radius:4px; padding:2px 10px; cursor:pointer; font-size:12px; }
  #detail-head { padding:8px 12px 0; }
  #detail-conns { padding:0 12px 12px; }
  .insp-sep { margin:8px 12px 0; border-top:1px solid var(--vscode-panel-border,#8883); }
  .mini { width:100%; height:170px; display:block; margin:8px 0 2px; }
  .mini line { stroke: var(--vscode-panel-border,#8886); stroke-width:1.2; }
  .mini .mn rect { fill: var(--vscode-badge-background,#333); stroke: var(--vscode-panel-border,#8886); rx:4; cursor:pointer; }
  .mini .mn:hover rect { stroke: var(--vscode-focusBorder,#4ec9b0); stroke-width:1.6; }
  .mini .mn text { fill: var(--vscode-badge-foreground,#eee); font-size:11px; pointer-events:none; }
  .mini .mn.center rect { fill: var(--vscode-list-activeSelectionBackground,#0a63c9); stroke: var(--vscode-focusBorder,#4ec9b0); }
  .mini .mn.center text { fill: var(--vscode-list-activeSelectionForeground,#fff); }
  .mini .elabel { fill: var(--vscode-descriptionForeground); font-size:9px; text-transform:uppercase; }
  .mini .more { fill: var(--vscode-descriptionForeground); font-size:10px; }
  ${AMD_TOOLBAR_CSS}
</style></head><body>
${amdToolbar('outline')}
<div class="top">
  <input id="q" type="search" placeholder="Search nodes…" autofocus>
  <span class="muted" id="count"></span>
</div>
<div class="filters" id="filters"></div>
<div class="split">
  <div class="list" id="list"></div>
  <div class="detail">
    <div id="detail-head"><div class="empty">Select a node to edit it and see what connects to it.</div></div>
    <div id="insp-mount"></div>
    <div id="detail-conns"></div>
  </div>
</div>
${inj.scripts}${inspectorFormScript(webview, nonce)}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const graph = ${data};
  const nodes = graph.nodes || [], edges = graph.edges || [];
  const byKey = {}; for (const n of nodes) byKey[n.key] = n;
  const sections = [...new Set(nodes.map(n => n.section || 'other'))].sort();
  const hidden = new Set();
  let sel = null;
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // filters (one toggle per section)
  const fbox = document.getElementById('filters');
  fbox.innerHTML = sections.map(s => '<label><input type="checkbox" data-s="'+esc(s)+'" checked> '+esc(s)+'</label>').join('');
  fbox.querySelectorAll('input').forEach(cb => cb.onchange = () => {
    if (cb.checked) hidden.delete(cb.dataset.s); else hidden.add(cb.dataset.s); renderList();
  });
  document.getElementById('q').oninput = renderList;

  function renderList() {
    const q = document.getElementById('q').value.trim().toLowerCase();
    const list = document.getElementById('list');
    let shown = 0; const parts = [];
    for (const s of sections) {
      if (hidden.has(s)) continue;
      const group = nodes.filter(n => (n.section||'other') === s &&
        (!q || (n.display||'').toLowerCase().includes(q) || (n.key||'').toLowerCase().includes(q)));
      if (!group.length) continue;
      const add = (s && s !== 'other') ? '<span class="addbtn" data-section="'+esc(s)+'" title="Add a new entity to this section">+ add</span>' : '';
      parts.push('<div class="sec">'+esc(s)+' ('+group.length+')'+add+'</div>');
      for (const n of group) {
        shown++;
        parts.push('<div class="row'+(n.key===sel?' sel':'')+'" data-k="'+esc(n.key)+'">'
          + esc(n.display||n.key) + ' <span class="k">'+esc(n.key)+'</span>' + badges(n) + '</div>');
      }
    }
    list.innerHTML = parts.join('') || '<div class="empty">No matching nodes.</div>';
    document.getElementById('count').textContent = shown + ' / ' + nodes.length;
    list.querySelectorAll('.row').forEach(r => r.onclick = () => select(r.dataset.k));
    list.querySelectorAll('.addbtn').forEach(b => b.onclick = (ev) => { ev.stopPropagation();
      vscode.postMessage({ type:'addEntity', section: b.dataset.section }); });
  }
  function badges(n){ const p=n.problems; if(!p) return '';
    return (p.error?' <span class="badge err">'+p.error+'</span>':'')+(p.warning?' <span class="badge warn">'+p.warning+'</span>':''); }

  function select(key) {
    sel = key;
    document.querySelectorAll('.row').forEach(r => r.classList.toggle('sel', r.dataset.k===key));
    const n = byKey[key];
    const head = document.getElementById('detail-head');
    const conns = document.getElementById('detail-conns');
    if (!n) { head.innerHTML = '<div class="empty">Unknown node.</div>'; conns.innerHTML=''; return; }
    head.innerHTML =
      '<div class="dtitle">'+esc(n.display||n.key)+badges(n)+'</div>'
      + '<div class="dkey">'+esc(n.key)+' · '+esc(n.section||'')+'</div>'
      + '<div class="dactions"><button id="open">Open source</button></div>';
    document.getElementById('open').onclick = () => vscode.postMessage({ type:'goto', uri:n.uri, line:n.line });
    // The editable inspector loads inline (into #insp-mount) — no Edit button.
    vscode.postMessage({ type:'inspect', uri:n.uri, key:n.key });
    const out = edges.filter(e => e.from === key);
    const inc = edges.filter(e => e.to === key);
    conns.innerHTML = '<div class="insp-sep"></div>'
      + miniGraph(key, out, inc)
      + group('Leads to', out, 'to') + group('Reached from', inc, 'from');
    conns.querySelectorAll('.mn').forEach(g => { if (g.dataset.k && g.dataset.k !== key) g.onclick = () => select(g.dataset.k); });
    conns.querySelectorAll('.chip').forEach(c => c.onclick = () => select(c.dataset.k));
    conns.querySelectorAll('.src').forEach(s => s.onclick = (ev) => { ev.stopPropagation();
      vscode.postMessage({ type:'goto', uri:s.dataset.uri, line:+s.dataset.line }); });
  }
  function group(title, list, endpoint) {
    if (!list.length) return '<div class="grp">'+title+'</div><div class="muted" style="padding-left:4px">none</div>';
    const chips = list.map(e => {
      const other = e[endpoint]; const on = byKey[other];
      return '<span class="chip" data-k="'+esc(other)+'"><span class="ek">'+esc(e.kind)+'</span>'
        + esc(on ? (on.display||other) : other)
        + '</span><span class="src" data-uri="'+esc(e.uri)+'" data-line="'+esc(e.line)+'">↪ src</span>';
    }).join(' ');
    return '<div class="grp">'+title+' ('+list.length+')</div><div>'+chips+'</div>';
  }
  // A 1-hop mini-graph: the selected node in the middle, incoming on the left,
  // outgoing on the right. Neighbor nodes are clickable to re-focus.
  function miniGraph(key, out, inc) {
    const W=340, H=170, cx=W/2, cy=H/2, hw=44, hh=11;
    const cap = 4;
    const outN = out.slice(0, cap), incN = inc.slice(0, cap);
    function label(k) { const n = byKey[k]; let t = (n && (n.display || k)) || k; return t.length > 13 ? t.slice(0,12)+'…' : t; }
    function node(x, y, k, cls) {
      return '<g class="mn '+cls+'" data-k="'+esc(k)+'">'
        + '<rect x="'+(x-hw)+'" y="'+(y-hh)+'" width="'+(hw*2)+'" height="'+(hh*2)+'"/>'
        + '<text x="'+x+'" y="'+(y+4)+'" text-anchor="middle">'+esc(label(k))+'</text></g>';
    }
    function spread(list, n) { const step = H/(list.length+1); return step*(n+1); }
    let s = '';
    incN.forEach((e,i) => { const y=spread(incN,i), x=hw+6;
      s += '<line x1="'+(x+hw)+'" y1="'+y+'" x2="'+(cx-hw)+'" y2="'+cy+'"/>'
        + '<text class="elabel" x="'+(x+hw+8)+'" y="'+(y-13)+'">'+esc(e.kind||'')+'</text>'
        + node(x, y, e.from, 'in'); });
    outN.forEach((e,i) => { const y=spread(outN,i), x=W-hw-6;
      s += '<line x1="'+(cx+hw)+'" y1="'+cy+'" x2="'+(x-hw)+'" y2="'+y+'"/>'
        + '<text class="elabel" x="'+(x-hw-8)+'" y="'+(y-13)+'" text-anchor="end">'+esc(e.kind||'')+'</text>'
        + node(x, y, e.to, 'out'); });
    s += node(cx, cy, key, 'center');
    if (inc.length > cap) s += '<text class="more" x="'+(hw+6)+'" y="'+(H-3)+'" text-anchor="middle">+'+(inc.length-cap)+' more</text>';
    if (out.length > cap) s += '<text class="more" x="'+(W-hw-6)+'" y="'+(H-3)+'" text-anchor="middle">+'+(out.length-cap)+' more</text>';
    return '<svg class="mini" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+s+'</svg>';
  }

  // Integrated inspector: the extension answers 'inspect' with insp:render.
  let inspHandle = null;
  const inspMount = document.getElementById('insp-mount');
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m.type !== 'string' || m.type.indexOf('insp:') !== 0) { return; }
    if (m.type === 'insp:render') {
      if (!inspHandle) { inspHandle = InspectorForm.mount(inspMount, vscode, { prefix: 'insp:', model: m.model, faceAvailable: ${inj.available} }); }
      else { inspHandle.render(m.model); }
    } else if (m.type === 'insp:patch' && inspHandle) { inspHandle.patch(m); }
    else if (m.type === 'insp:setFace' && inspHandle) { inspHandle.setFace(m.value); }
  });

  renderList();
  const preselect = ${preselect};
  if (preselect && byKey[preselect]) { select(preselect);
    const r = document.querySelector('.row.sel'); if (r) r.scrollIntoView({ block:'nearest' }); }
  else { vscode.postMessage({ type:'inspReady' }); }
  ${AMD_TOOLBAR_JS}
</script></body></html>`;
}

// A cross-tool switcher shared by the AMD panels, so you can jump between the
// Outline / Graph / Resolver / Map / Inspector without returning to the editor.
// Ordered for a document's lifetime: authoring tools first, then live testing.
const AMD_TOOLS: [string, string][] = [
  ['outline', 'Outline'], ['graph', 'Graph'], ['resolver', 'Resolver'],
  ['map', 'Map'], ['inspector', 'Inspector'],
];
function amdToolbar(current: string): string {
  const btns = AMD_TOOLS.map(([k, l]) =>
    `<button class="amdtool${k === current ? ' cur' : ''}" data-tool="${k}"${k === current ? ' disabled' : ''}>${l}</button>`).join('');
  return `<div class="amdtools">${btns}</div>`;
}
const AMD_TOOLBAR_CSS = `
  .amdtools { display:flex; gap:4px; padding:4px 8px; flex-wrap:wrap; align-items:center; border-bottom:1px solid var(--vscode-panel-border,#8882); }
  .amdtools button { background:var(--vscode-button-secondaryBackground,#444); color:var(--vscode-button-secondaryForeground,#fff); border:none; border-radius:4px; padding:2px 8px; font-size:11px; cursor:pointer; }
  .amdtools button.cur { background:var(--vscode-button-background,#0a63c9); color:#fff; cursor:default; opacity:.85; }
  .amdtools button:not(.cur):hover { background:var(--vscode-button-secondaryHoverBackground,#555); }`;
const AMD_TOOLBAR_JS = `for (const b of document.querySelectorAll('.amdtools button')) { if (!b.disabled) b.addEventListener('click', () => vscode.postMessage({ type:'openTool', tool:b.dataset.tool })); }`;

// The last .amd a tool was opened for — a fallback so a panel with no document
// of its own (the Mission Inspector) can still launch document tools.
let lastAmdUri: string | undefined;
function resolveAmdUri(preferred?: string): string | undefined {
  if (preferred) { return preferred; }
  const active = vscode.window.activeTextEditor;
  if (active?.document.languageId === 'amd') { return active.document.uri.toString(); }
  const vis = vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'amd');
  return vis ? vis.document.uri.toString() : lastAmdUri;
}

// Open a sibling tool for the same document, in the SAME editor group as the
// launching panel (so tools stack as tabs, never split the layout further).
function openAmdTool(tool: string, uri?: string, column?: vscode.ViewColumn): void {
  const col = column ?? vscode.ViewColumn.Beside;
  if (tool === 'inspector') { showMissionInspector(col); return; }
  const u = resolveAmdUri(uri);
  if (!u) { vscode.window.showWarningMessage('Artemis AMD: open an .amd file first to launch this tool.'); return; }
  if (tool === 'outline') { void showStoryOutline(u, col); }
  else if (tool === 'graph') { void showGraph(u, col); }
  else if (tool === 'resolver') { void showAmdResolver(u, col); }
  else if (tool === 'map') { void showMap(u, col); }
}

// One live panel per tool, keyed by tool name — so opening a tool reveals its
// existing panel (for the same document) instead of stacking duplicates. A tool
// re-opened for a DIFFERENT document replaces the stale panel.
const toolPanels = new Map<string, { panel: vscode.WebviewPanel; uri: string }>();
function reuseToolPanel(tool: string, uri: string, column: vscode.ViewColumn): boolean {
  const cur = toolPanels.get(tool);
  if (!cur) { return false; }
  if (cur.uri === uri) { cur.panel.reveal(column, true); return true; }
  cur.panel.dispose();                 // different document → rebuild fresh
  toolPanels.delete(tool);
  return false;
}
function registerToolPanel(tool: string, uri: string, panel: vscode.WebviewPanel): void {
  toolPanels.set(tool, { panel, uri });
  panel.onDidDispose(() => { if (toolPanels.get(tool)?.panel === panel) { toolPanels.delete(tool); } });
}

async function showStoryOutline(uriArg?: string, column: vscode.ViewColumn = vscode.ViewColumn.Beside): Promise<void> {
  if (!client) {
    vscode.window.showWarningMessage('Artemis AMD: the language server is not running.');
    return;
  }
  if (!client.isRunning() && !(await ensureClientReady())) {
    vscode.window.showWarningMessage('Artemis AMD: the language server is still starting — try again in a moment.');
    return;
  }
  const uri = uriArg ?? vscode.window.activeTextEditor?.document.uri.toString();
  if (!uri) { return; }
  lastAmdUri = uri;
  let graph: MissionGraph;
  try {
    graph = await client.sendRequest<MissionGraph>('amd/graph', { textDocument: { uri } });
  } catch (e) {
    vscode.window.showErrorMessage(`Artemis AMD: could not build the outline (${e}).`);
    return;
  }
  if (reuseToolPanel('outline', uri, column)) { return; }
  const panel = vscode.window.createWebviewPanel(
    'amdStoryOutline', 'Story Outline', column,
    { enableScripts: true, localResourceRoots: faceWebviewRoots() });
  registerToolPanel('outline', uri, panel);
  const nonce = () => String(Date.now()) + Math.random().toString(36).slice(2);
  let selectedKey: string | undefined;
  panel.webview.html = storyOutlineHtml(graph, nonce(), panel.webview, selectedKey);

  // The integrated inspector: selecting a node loads its editable form inline
  // (into #insp-mount) — same shared drawer the Story Graph uses.
  const drawer: Inspector = {
    webview: panel.webview, uri: '', detail: undefined, selfEdit: false, busy: false,
    prefix: 'insp:',
    render: (d) => panel.webview.postMessage({ type: 'insp:render', model: formModel(d) }),
    reveal: () => { /* the form is always visible in the detail pane */ },
  };
  drawerInspectors.add(drawer);
  wireInspector(drawer);

  const refresh = async () => {
    try {
      const g = await client!.sendRequest<MissionGraph>('amd/graph', { textDocument: { uri } });
      panel.webview.html = storyOutlineHtml(g, nonce(), panel.webview, selectedKey);
    } catch (e) { output.appendLine(`Outline refresh failed: ${e}`); }
  };
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
    // Don't refresh while the drawer is applying its own edit (keeps the form).
    if (e.document.languageId === 'amd' && !drawer.busy) {
      clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { void refresh(); }, 300);
    }
  });
  panel.onDidDispose(() => {
    drawerInspectors.delete(drawer);
    if (faceHost === drawer) { faceHost = undefined; }
    docSub.dispose();
  });

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === 'goto') {
      openLocation(msg.uri, msg.line);
    } else if (msg?.type === 'inspect') {
      selectedKey = msg.key;
      await loadNodeInto(drawer, msg.uri, msg.key);   // renders the form inline
    } else if (msg?.type === 'inspReady') {
      if (drawer.detail) { drawer.render(drawer.detail); }
    } else if (msg?.type === 'addEntity') {
      // Insert without the standalone inspector; select the new node so its form
      // loads in the Outline's own inline detail pane on the next refresh.
      const key = await addEntityInSection(uri, msg.section, false);
      if (key) { selectedKey = key; }
    } else if (msg?.type === 'openTool') {
      openAmdTool(msg.tool, uri, panel.viewColumn);
    }
  });
}

// --- AMD Live Resolver (static half, §3.5): two panes over the `amd/resolve`
// model — left, the resolved entity tree as the engine built it (grouped by
// archetype, badged); right, the red-flags (dangling refs, orphan headings,
// structural + cross-file lint). Every row jumps to source. No live tap needed.
function amdResolverHtml(model: ResolveModel, nonce: string): string {
  const data = JSON.stringify(model);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin:0; display:flex; flex-direction:column; height:100vh; }
  .top { display:flex; gap:8px; align-items:center; padding:5px 10px; border-bottom:1px solid var(--vscode-panel-border,#8882); flex-wrap:wrap; }
  .top input[type=search] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border,#8883); border-radius:4px; padding:2px 8px; font-size:12px; width:180px; }
  .top label { font-size:11px; color: var(--vscode-descriptionForeground); cursor:pointer; }
  .muted { color: var(--vscode-descriptionForeground); }
  .split { display:grid; grid-template-columns: minmax(0,1.4fr) minmax(0,1fr); flex:1; min-height:0; user-select:none; }
  .pane { overflow:auto; min-height:0; }
  .pane.model { border-right:1px solid var(--vscode-panel-border,#8883); }
  .bar { padding:4px 10px; font-size:11px; text-transform:uppercase; color:var(--vscode-descriptionForeground); position:sticky; top:0; background:var(--vscode-editor-background); border-bottom:1px solid var(--vscode-panel-border,#8882); display:flex; gap:8px; align-items:center; z-index:1; }
  .bar b { color: var(--vscode-foreground); }
  .grp { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--vscode-descriptionForeground); padding:8px 10px 2px; display:flex; align-items:center; gap:6px; }
  .addbtn { margin-left:auto; cursor:pointer; border:1px solid var(--vscode-panel-border,#8884); border-radius:3px; padding:0 6px; line-height:16px; color:var(--vscode-descriptionForeground); }
  .addbtn:hover { color:var(--vscode-foreground); border-color:var(--vscode-focusBorder,#4ec9b0); background:var(--vscode-list-hoverBackground,#8881); }
  .ent { display:flex; align-items:center; gap:6px; padding:2px 10px 2px 6px; cursor:pointer; white-space:nowrap; }
  .ent:hover { background: var(--vscode-list-hoverBackground,#8881); }
  .ent.sel { background: var(--vscode-list-activeSelectionBackground,#0a63c9); color:#fff; }
  .car { width:12px; display:inline-block; text-align:center; color:var(--vscode-descriptionForeground); cursor:pointer; }
  .dot { width:8px; height:8px; border-radius:2px; flex:0 0 auto; }
  .ename { font-weight:500; }
  .ekey { color: var(--vscode-descriptionForeground); font-size:11px; font-family: var(--vscode-editor-font-family); }
  .ent.sel .ekey { color:#cde; }
  .badge { font-size:10px; border-radius:6px; padding:0 5px; }
  .badge.err { background: var(--vscode-inputValidation-errorBackground,#5a1d1d); color:#f88; }
  .badge.warn { background: var(--vscode-inputValidation-warningBackground,#5a4a1d); color:#fc8; }
  .badge.orphan { background: #5a3a1d; color:#fc8; }
  .refs { padding:0 0 2px 30px; }
  .refs .reflabel { color: var(--vscode-descriptionForeground); font-size:10px; text-transform:uppercase; letter-spacing:.04em; padding:3px 0 1px; }
  .ref { font-family: var(--vscode-editor-font-family); font-size:12px; padding:1px 10px; cursor:pointer; white-space:nowrap; }
  .ref:hover { background: var(--vscode-list-hoverBackground,#8881); }
  .ref .rk { color: var(--vscode-symbolIcon-eventForeground,#c586c0); }
  .ref .ok { color: var(--vscode-testing-iconPassed,#89d185); }
  .ref .bad { color: var(--vscode-errorForeground,#f66); }
  .issue { display:flex; gap:6px; align-items:flex-start; padding:4px 10px; cursor:pointer; border-bottom:1px solid var(--vscode-panel-border,#8882); font-size:12px; }
  .issue:hover { background: var(--vscode-list-hoverBackground,#8881); }
  .issue .sev { width:8px; height:8px; border-radius:50%; flex:0 0 auto; margin-top:4px; }
  .issue .sev.error { background: var(--vscode-errorForeground,#f66); }
  .issue .sev.warning { background: var(--vscode-editorWarning-foreground,#fc8); }
  .issue .ibody { flex:1; min-width:0; }
  .issue .msg { line-height:1.35; overflow-wrap:anywhere; }
  .issue .meta { margin-top:2px; display:flex; gap:8px; flex-wrap:wrap; }
  .issue .code { color: var(--vscode-descriptionForeground); font-size:11px; font-family: var(--vscode-editor-font-family); }
  .issue .loc { color: var(--vscode-textLink-foreground,#4daafc); font-size:11px; }
  .empty { padding:12px; color: var(--vscode-descriptionForeground); }
  ${AMD_TOOLBAR_CSS}
</style></head><body>
${amdToolbar('resolver')}
<div class="top">
  <input id="q" type="search" placeholder="Filter entities…" autofocus>
  <label><input type="checkbox" id="probOnly"> problems only</label>
  <span class="muted" id="counts"></span>
  <span style="flex:1"></span>
  <span class="muted" style="font-size:11px">single-click browses · double-click opens source</span>
</div>
<div class="split">
  <div class="pane model">
    <div class="bar"><b>Resolved model</b><span class="muted" id="mCount"></span></div>
    <div id="tree"></div>
  </div>
  <div class="pane">
    <div class="bar"><b>Red flags</b><span class="muted" id="iCount"></span></div>
    <div id="issues"></div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const MODEL = ${data};
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function goto(uri, line){ vscode.postMessage({ type:'goto', uri:uri, line:line }); }

  const byKey = {};
  for (const e of MODEL.entities) byKey[e.key] = e;
  const outRefs = {};                                   // owner key -> [ref] (what it leads to)
  const inRefs = {};                                    // target key -> [ref] (what reaches it)
  for (const r of MODEL.refs) {
    (outRefs[r.owner] = outRefs[r.owner] || []).push(r);
    const leaf = String(r.value).split('/').pop();
    if (byKey[leaf]) { (inRefs[leaf] = inRefs[leaf] || []).push(r); }   // resolved edge into an entity
  }
  const entsByUri = {};                                 // uri -> [entity] sorted by line (map an issue -> its entity)
  for (const e of MODEL.entities) (entsByUri[e.uri] = entsByUri[e.uri] || []).push(e);
  for (const u in entsByUri) entsByUri[u].sort((a,b) => a.line - b.line);
  function entityForIssue(it){ let f = null; for (const e of (entsByUri[it.uri]||[])){ if (e.line <= it.line) f = e; else break; } return f; }
  function scrollSelIntoView(){ const el = document.querySelector('.ent.sel'); if (el) el.scrollIntoView({ block:'nearest' }); }
  function selectEntity(key){ const e = byKey[key]; if (!e) return; sel = key; if ((outRefs[key]||[]).length || (inRefs[key]||[]).length) expanded[key] = true; renderTree(); scrollSelIntoView(); }

  const ARCH = {
    quest:'#c586c0', scene:'#4ec9b0', dialogue:'#4daafc', lifeform:'#89d185',
    scan:'#dcdcaa', side:'#e8a35c', item:'#9ca0ff', region:'#5ec8c8', face:'#d18cd1'
  };
  const ORDER = ['quest','scene','dialogue','lifeform','scan','side','item','region','face'];
  function archColor(a){ return ARCH[a] || '#8899aa'; }
  function archRank(a){ const i = ORDER.indexOf(a); return i < 0 ? ORDER.length : i; }

  const expanded = {};                                  // key -> bool
  let sel = null;

  function danglingCount(){ return MODEL.refs.filter(r => !r.resolved).length; }
  function orphanEnts(){ return MODEL.entities.filter(e => e.orphan); }

  function renderTree(){
    const q = document.getElementById('q').value.trim().toLowerCase();
    const probOnly = document.getElementById('probOnly').checked;
    const match = e => {
      if (probOnly && !e.orphan && !(e.problems && (e.problems.error || e.problems.warning))
          && !(outRefs[e.key]||[]).some(r => !r.resolved)) return false;
      if (!q) return true;
      return (e.display||'').toLowerCase().includes(q) || (e.key||'').toLowerCase().includes(q)
          || (e.archetype||'').toLowerCase().includes(q);
    };
    const ents = MODEL.entities.filter(match);
    document.getElementById('mCount').textContent = ents.length ? '('+ents.length+')' : '';
    // group by archetype, ordered; nodes with no archetype (e.g. dialogue prose)
    // fall back to their section so they read as "dialogue", not "other".
    const groups = {};
    for (const e of ents) { const gk = e.archetype || e.section || 'other'; (groups[gk] = groups[gk] || []).push(e); }
    const names = Object.keys(groups).sort((a,b) => (archRank(a)-archRank(b)) || a.localeCompare(b));
    const out = [];
    for (const g of names){
      const section = (groups[g][0] && groups[g][0].section) || '';
      const add = section ? '<span class="addbtn" data-section="'+esc(section)+'" title="Add a new entity to this section">+ add</span>' : '';
      out.push('<div class="grp">'+esc(g||'other')+' ('+groups[g].length+')'+add+'</div>');
      for (const e of groups[g]) out.push(entRow(e));
    }
    document.getElementById('tree').innerHTML = out.join('') || '<div class="empty">No entities match.</div>';
    wireTree();
  }
  function refRow(sel, uri, line, inner){
    return '<div class="ref" data-sel="'+esc(sel||'')+'" data-uri="'+esc(uri)+'" data-line="'+line+'">'+inner+'</div>';
  }
  function outRefHtml(r){
    const leaf = String(r.value).split('/').pop();
    const ok = r.resolved; const tgt = ok ? byKey[leaf] : null;
    const inner = '<span class="rk">'+esc(r.kind)+'</span> '
      + (ok ? '<span class="ok">✓</span> ' : '<span class="bad">✗</span> ') + esc(r.value)
      + (ok ? '' : ' <span class="bad">'+esc(r.code||'unresolved')+'</span>');
    return refRow(ok ? leaf : '', tgt ? tgt.uri : r.uri, tgt ? tgt.line : r.line, inner);
  }
  function inRefHtml(r){
    const on = byKey[r.owner];
    const inner = '<span class="rk">'+esc(r.kind)+'</span> <span class="ok">←</span> '
      + esc(on ? (on.display||r.owner) : r.owner);
    return refRow(r.owner, r.uri, r.line, inner);   // jump goes to where the reference is written
  }
  function entRow(e){
    const outR = outRefs[e.key] || [], inR = inRefs[e.key] || [];
    const hasRefs = outR.length || inR.length;
    const caret = hasRefs ? (expanded[e.key] ? '▾' : '▸') : '';
    let badges = '';
    if (e.problems && e.problems.error) badges += ' <span class="badge err">'+e.problems.error+'</span>';
    if (e.problems && e.problems.warning) badges += ' <span class="badge warn">'+e.problems.warning+'</span>';
    if (e.orphan) badges += ' <span class="badge orphan" title="unreachable — nothing reveals it and it has no When:/signal trigger">orphan</span>';
    let row = '<div class="ent'+(sel===e.key?' sel':'')+'" data-k="'+esc(e.key)+'">'
      + '<span class="car" data-car="'+esc(e.key)+'">'+caret+'</span>'
      + '<span class="dot" style="background:'+archColor(e.archetype || e.section)+'"></span>'
      + '<span class="ename">'+esc(e.display)+'</span> <span class="ekey">'+esc(e.key)+'</span>'
      + badges + '</div>';
    if (hasRefs && expanded[e.key]){
      let sub = '<div class="refs">';
      if (outR.length) { sub += '<div class="reflabel">→ leads to</div>' + outR.map(outRefHtml).join(''); }
      if (inR.length)  { sub += '<div class="reflabel">← reached by</div>' + inR.map(inRefHtml).join(''); }
      row += sub + '</div>';
    }
    return row;
  }
  function wireTree(){
    // Single-click browses in the panel (select / expand); double-click opens the
    // source. Nothing moves the editor on a plain click.
    for (const b of document.querySelectorAll('.addbtn')){
      b.onclick = (ev) => { ev.stopPropagation(); vscode.postMessage({ type:'addEntity', section: b.dataset.section }); };
    }
    for (const c of document.querySelectorAll('.car')){
      c.onclick = (ev) => { ev.stopPropagation(); const k = c.dataset.car;
        if (!(outRefs[k]||[]).length && !(inRefs[k]||[]).length) return;
        expanded[k] = !expanded[k]; renderTree(); };
    }
    for (const el of document.querySelectorAll('.ent')){
      el.onclick = () => { const k = el.dataset.k;
        if (sel === k && expanded[k]) { expanded[k] = false; renderTree(); }  // click the open one again -> collapse
        else selectEntity(k); };
      el.ondblclick = () => { const e = byKey[el.dataset.k]; goto(e.uri, e.line); };
    }
    for (const el of document.querySelectorAll('.ref')){
      el.onclick = (ev) => { ev.stopPropagation();
        if (el.dataset.sel && byKey[el.dataset.sel]) selectEntity(el.dataset.sel); };   // browse to the related entity
      el.ondblclick = (ev) => { ev.stopPropagation(); goto(el.dataset.uri, +el.dataset.line); };  // open source
    }
  }

  function renderIssues(){
    // server lint issues + synthesized orphan flags, errors first.
    const rows = MODEL.issues.slice();
    for (const e of orphanEnts())
      rows.push({ uri:e.uri, line:e.line, col:0, severity:'warning', code:'orphan',
                  message:'"'+(e.display||e.key)+'" is unreachable — nothing reveals it and it has no When:/signal trigger' });
    const rank = s => s === 'error' ? 0 : 1;
    rows.sort((a,b) => (rank(a.severity)-rank(b.severity)) || (a.uri||'').localeCompare(b.uri||'') || a.line-b.line);
    const errs = rows.filter(r => r.severity === 'error').length;
    document.getElementById('iCount').textContent = rows.length ? '('+errs+' err, '+(rows.length-errs)+' warn)' : '';
    const shortUri = u => { const s = String(u||''); const i = s.replace(/\\\\/g,'/').lastIndexOf('/'); return i<0? s : s.slice(i+1); };
    document.getElementById('issues').innerHTML = rows.length ? rows.map((r,i) =>
      '<div class="issue" data-idx="'+i+'">'
      + '<span class="sev '+esc(r.severity)+'"></span>'
      + '<div class="ibody"><div class="msg">'+esc(r.message)+'</div>'
      + '<div class="meta"><span class="code">'+esc(r.code)+'</span>'
      + '<span class="loc">'+esc(shortUri(r.uri))+':'+(r.line+1)+'</span></div></div></div>'
    ).join('') : '<div class="empty">No problems — every reference resolves and every heading is reachable. ✓</div>';
    for (const el of document.querySelectorAll('.issue')){
      const it = rows[+el.dataset.idx];
      el.onclick = () => { const e = entityForIssue(it); if (e) selectEntity(e.key); };  // browse to the entity
      el.ondblclick = () => goto(it.uri, it.line);                                        // open the source line
    }
  }

  document.getElementById('counts').textContent =
    MODEL.entities.length + ' entities · ' + danglingCount() + ' dangling · ' + orphanEnts().length + ' orphan';
  document.getElementById('q').oninput = renderTree;
  document.getElementById('probOnly').onchange = renderTree;
  renderTree();
  renderIssues();
  ${AMD_TOOLBAR_JS}
</script></body></html>`;
}

// Insert a new record skeleton at the end of `section` (creating the section
// header if absent), then open the inspector on it. Shared by the "+" affordance
// in the Story Outline, Story Graph, and AMD Resolver. The panels auto-refresh on
// the resulting document change.
async function addEntityInSection(uri: string, section: string, openInspector = true): Promise<string | null> {
  if (!client || !section) { return null; }
  let r: NewInSection | null;
  try {
    r = await client.sendRequest<NewInSection | null>('amd/newInSection', { textDocument: { uri }, section });
  } catch (e) { output.appendLine(`Add entity failed: ${e}`); return null; }
  if (!r) { return null; }
  const edit = new vscode.WorkspaceEdit();
  edit.insert(vscode.Uri.parse(uri), new vscode.Position(r.line, 0), r.text);
  await vscode.workspace.applyEdit(edit);
  // The Story Outline edits inline in its own detail pane, so it selects the new
  // node itself instead; Graph/Resolver open the standalone inspector.
  if (openInspector) { await showInspector(uri, r.key); }
  return r.key;
}

async function showAmdResolver(uriArg?: string, column: vscode.ViewColumn = vscode.ViewColumn.Beside): Promise<void> {
  if (!client) {
    vscode.window.showWarningMessage('Artemis AMD: the language server is not running.');
    return;
  }
  if (!client.isRunning() && !(await ensureClientReady())) {
    vscode.window.showWarningMessage('Artemis AMD: the language server is still starting — try again in a moment.');
    return;
  }
  const uri = uriArg ?? vscode.window.activeTextEditor?.document.uri.toString();
  if (!uri) { return; }
  lastAmdUri = uri;
  let model: ResolveModel;
  try {
    model = await client.sendRequest<ResolveModel>('amd/resolve', { textDocument: { uri } });
  } catch (e) {
    vscode.window.showErrorMessage(`Artemis AMD: could not resolve the model (${e}).`);
    return;
  }
  if (reuseToolPanel('resolver', uri, column)) { return; }
  const panel = vscode.window.createWebviewPanel(
    'amdResolver', 'AMD Resolver', column, { enableScripts: true });
  registerToolPanel('resolver', uri, panel);
  const nonce = () => String(Date.now()) + Math.random().toString(36).slice(2);
  panel.webview.html = amdResolverHtml(model, nonce());

  const refresh = async () => {
    try {
      const m = await client!.sendRequest<ResolveModel>('amd/resolve', { textDocument: { uri } });
      panel.webview.html = amdResolverHtml(m, nonce());
    } catch (e) { output.appendLine(`Resolver refresh failed: ${e}`); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.languageId === 'amd') { clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 300); }
  });
  panel.onDidDispose(() => docSub.dispose());
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === 'goto') { openLocation(msg.uri, msg.line, { preserveFocus: true }); }
    else if (msg?.type === 'addEntity') { await addEntityInSection(uri, msg.section); }
    else if (msg?.type === 'openTool') { openAmdTool(msg.tool, uri, panel.viewColumn); }
  });
}

async function showGraph(uriArg?: string, column: vscode.ViewColumn = vscode.ViewColumn.Beside): Promise<void> {
  if (!client) {
    vscode.window.showWarningMessage('Artemis AMD: the language server is not running.');
    return;
  }
  if (!client.isRunning() && !(await ensureClientReady())) {
    vscode.window.showWarningMessage('Artemis AMD: the language server is still starting — try again in a moment.');
    return;
  }
  const uri = uriArg ?? vscode.window.activeTextEditor?.document.uri.toString();
  if (!uri) { return; }
  lastAmdUri = uri;
  let graph: MissionGraph;
  try {
    graph = await client.sendRequest<MissionGraph>('amd/graph', { textDocument: { uri } });
  } catch (e) {
    vscode.window.showErrorMessage(`Artemis AMD: could not build the graph (${e}).`);
    return;
  }
  if (reuseToolPanel('graph', uri, column)) { return; }
  const panel = vscode.window.createWebviewPanel(
    'amdGraph', 'AMD Story Graph', column,
    { enableScripts: true, localResourceRoots: faceWebviewRoots() },
  );
  registerToolPanel('graph', uri, panel);
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
    if (msg?.type === 'openTool') {
      openAmdTool(msg.tool, uri, panel.viewColumn); return;
    }
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
    } else if (msg?.type === 'addEntity') {
      await addEntityInSection(uri, msg.section);
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

async function showMap(uriArg?: string, column: vscode.ViewColumn = vscode.ViewColumn.Beside): Promise<void> {
  if (!client) {
    vscode.window.showWarningMessage('Artemis AMD: the language server is not running.');
    return;
  }
  if (!client.isRunning() && !(await ensureClientReady())) {
    vscode.window.showWarningMessage('Artemis AMD: the language server is still starting — try again in a moment.');
    return;
  }
  const uri = uriArg ?? vscode.window.activeTextEditor?.document.uri.toString();
  if (!uri) {
    return;
  }
  lastAmdUri = uri;
  let map: MissionMap;
  try {
    map = await client.sendRequest<MissionMap>('amd/map', { textDocument: { uri } });
  } catch (e) {
    vscode.window.showErrorMessage(`Artemis AMD: could not build the map (${e}).`);
    return;
  }
  if (reuseToolPanel('map', uri, column)) { return; }
  const panel = vscode.window.createWebviewPanel(
    'amdMap', 'AMD Mission Map', column,
    { enableScripts: true, localResourceRoots: faceWebviewRoots() },
  );
  registerToolPanel('map', uri, panel);
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
    if (msg?.type === 'openTool') {
      openAmdTool(msg.tool, uri, panel.viewColumn); return;
    }
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

/** How to invoke `sbs`: the Cosmos install's python + sbs.pyz, else `sbs` on PATH. */
function resolveSbsBase(): { command: string; args: string[]; cwd?: string } {
  const root = detectCosmosRoot();
  if (root) {
    const py = pythonExe(root);
    const missions = path.join(root, 'data', 'missions');
    const sbsPyz = path.join(missions, 'sbs.pyz');
    if (fs.existsSync(py) && fs.existsSync(sbsPyz)) {
      return { command: py, args: [sbsPyz], cwd: missions };
    }
  }
  return { command: 'sbs', args: [] };
}

// Runners the extension spawned, keyed by debug session id, so a session end can
// kill its runner (and the mission's self-cleanup is the backstop).
const missionRunners = new Map<string, cp.ChildProcess>();

function killTree(pid: number | undefined): void {
  if (!pid) { return; }
  try {
    if (process.platform === 'win32') {
      cp.spawn('taskkill', ['/F', '/T', '/PID', String(pid)]);
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* already gone */ }
}

/** Spawn `sbs debug <mission> --dap-port <port> --dap-wait [--map …]` PLAIN (no
 *  debugpy), streaming its output to the Artemis AMD channel. */
function spawnMissionRunner(session: vscode.DebugSession, port: number): cp.ChildProcess {
  const cfg = session.configuration || {};
  let mission: string = cfg.mission || session.workspaceFolder?.uri.fsPath || '.';
  if (session.workspaceFolder) {
    mission = mission.replace(/\$\{workspaceFolder\}/g, session.workspaceFolder.uri.fsPath);
  }
  const base = resolveSbsBase();
  const args = [...base.args, 'debug', mission, '--dap-port', String(port), '--dap-wait'];
  if (cfg.map !== undefined && cfg.map !== null && String(cfg.map) !== '') {
    args.push('--map', String(cfg.map));
  }
  if (cfg.useWorkingTree) { args.push('--use-working-tree'); }
  output.show(true);
  output.appendLine(`Launching mission: ${base.command} ${args.join(' ')}`);
  const child = cp.spawn(base.command, args, { cwd: base.cwd, windowsHide: true });
  child.stdout?.on('data', (d: Buffer) => output.append(d.toString()));
  child.stderr?.on('data', (d: Buffer) => output.append(d.toString()));
  child.on('exit', (code) => output.appendLine(`[mission runner exited: ${code}]`));
  child.on('error', (err) => output.appendLine(`[mission runner failed to start: ${err.message}]`));
  return child;
}

class MastDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const cfg = session.configuration;
    const host = cfg.host ?? '127.0.0.1';
    const port = cfg.port ?? 4711;

    // launch + mission: the extension OWNS the runner — spawn `sbs debug` plain,
    // wait for it, connect, and kill it when the session ends. One click, no task.
    if (cfg.request === 'launch' && cfg.mission) {
      const child = spawnMissionRunner(session, port);
      missionRunners.set(session.id, child);
      output.appendLine(`DAP launch: waiting for ${host}:${port} …`);
      return waitForPort(host, port, 60000).then(
        () => {
          output.appendLine(`DAP launch: connected ${host}:${port}`);
          return new vscode.DebugAdapterServer(port, host);
        },
        (err) => { killTree(child.pid); missionRunners.delete(session.id); throw err; },
      );
    }

    // attach: connect to a mission already serving DAP.
    if (cfg.request === 'attach') {
      output.appendLine(`DAP attach: waiting for ${host}:${port} …`);
      return waitForPort(host, port, 30000).then(() => {
        output.appendLine(`DAP attach: connected ${host}:${port}`);
        return new vscode.DebugAdapterServer(port, host);
      });
    }

    // launch a single .mast via `sbs dap` over stdio.
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
    // A mission launch uses `mission`; only default `program` for a single-.mast launch.
    if (config.type === 'mast' && !config.program && !config.mission) {
      config.program = '${file}';
    }
    return config;
  }
}

// --- Mission Inspector (live signals + world, over `mast/inspect` events) ---
let missionInspectorPanel: vscode.WebviewPanel | undefined;

function inspectorNonce(): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) { s += c[Math.floor(Math.random() * c.length)]; }
  return s;
}

function missionInspectorHtml(nonce: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin:0; display:flex; flex-direction:column; height:100vh; }
  .split { display:grid; flex:1; min-height:0; grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-template-rows:1fr 1fr; }
  .pane { overflow:auto; border-right:1px solid var(--vscode-panel-border,#8883); border-bottom:1px solid var(--vscode-panel-border,#8883); min-height:0; }
  .bar { padding:4px 10px; font-size:11px; text-transform:uppercase; color:var(--vscode-descriptionForeground); position:sticky; top:0; background:var(--vscode-editor-background); border-bottom:1px solid var(--vscode-panel-border,#8882); display:flex; gap:8px; align-items:center; }
  .bar b { color:var(--vscode-foreground); }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { text-align:left; padding:2px 8px; border-bottom:1px solid var(--vscode-panel-border,#8882); white-space:nowrap; }
  .muted { color: var(--vscode-descriptionForeground); }
  .empty { padding:10px; color: var(--vscode-descriptionForeground); }
  .foe { color: var(--vscode-errorForeground,#f66); font-weight:600; }
  .wrow { cursor:pointer; }
  .wrow:hover { background: var(--vscode-list-hoverBackground,#8881); }
  .invcell { font-family: var(--vscode-editor-font-family); font-size:11px; white-space:normal; padding-left:18px; }
  .sig .ts { color: var(--vscode-descriptionForeground); font-size:11px; margin-right:6px; }
  .sig { font-family: var(--vscode-editor-font-family); font-size:12px; padding:2px 10px; border-bottom:1px solid var(--vscode-panel-border,#8882); }
  .sig .name { color: var(--vscode-symbolIcon-eventForeground, #c586c0); font-weight:600; }
  button, .sel { background: var(--vscode-button-secondaryBackground,#444); color: var(--vscode-button-secondaryForeground,#fff); border:none; border-radius:4px; padding:1px 8px; cursor:pointer; font-size:11px; }
  button.on { background: var(--vscode-button-background,#0a63c9); color:#fff; }
  .flt { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border,#8883); border-radius:4px; padding:1px 6px; font-size:11px; width:110px; }
  .flt:focus { outline:1px solid var(--vscode-focusBorder,#4ec9b0); }
  .bar .sp { flex:1; }
  .wnode { font-family: var(--vscode-editor-font-family); font-size:12px; padding:1px 10px; white-space:nowrap; }
  .wnode .wtype { color: var(--vscode-symbolIcon-classForeground,#4ec9b0); }
  .wnode .wtag { color: var(--vscode-foreground); }
  .wnode .wrect { color: var(--vscode-descriptionForeground); }
  .bagent { font-size:12px; padding:3px 10px 1px; font-weight:600; border-top:1px solid var(--vscode-panel-border,#8882); }
  .bagent .pz { color: var(--vscode-descriptionForeground); font-weight:400; }
  .bnode { font-family: var(--vscode-editor-font-family); font-size:12px; padding:1px 10px; white-space:nowrap; }
  .bnode .btype { color: var(--vscode-symbolIcon-classForeground,#4ec9b0); }
  .bnode.on { color: var(--vscode-testing-iconPassed,#89d185); }
  .bnode .bres { color: var(--vscode-descriptionForeground); }
  ${AMD_TOOLBAR_CSS}
</style></head><body>
${amdToolbar('inspector')}
<div class="split">
  <div class="pane">
    <div class="bar"><b>World</b><input id="worldFilter" class="flt" type="search" placeholder="filter…"><label style="text-transform:none"><input type="checkbox" id="foesOnly"> enemies</label><span class="sp"></span><span class="muted" id="worldCount"></span></div>
    <table><thead><tr><th>Name</th><th>Side</th><th>Kind</th><th title="Diplomatically hostile to a player side">Enemy?</th><th>Roles</th></tr></thead>
    <tbody id="worldBody"><tr><td colspan="5" class="empty">Waiting for a running mission…</td></tr></tbody></table>
  </div>
  <div class="pane">
    <div class="bar"><b>Signals</b><input id="sigFilter" class="flt" type="search" placeholder="filter…"><span class="sp"></span><button id="sigPause" title="Freeze auto-scroll">Pause</button><button id="clear">Clear</button><span class="muted" id="sigCount"></span></div>
    <div id="sigLog"></div>
  </div>
  <div class="pane">
    <div class="bar"><b>Widgets</b><select id="wClient" class="sel"></select><span class="muted" id="wCount"></span></div>
    <div id="wTree"><div class="empty">Waiting for a GUI frame…</div></div>
  </div>
  <div class="pane">
    <div class="bar"><b>Brains</b><span class="muted" id="bCount"></span></div>
    <div id="bTree"><div class="empty">Waiting for agent brains…</div></div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  ${AMD_TOOLBAR_JS}
  const worldBody = document.getElementById('worldBody');
  const worldCount = document.getElementById('worldCount');
  const worldFilter = document.getElementById('worldFilter');
  const sigLog = document.getElementById('sigLog');
  const sigCount = document.getElementById('sigCount');
  const sigFilter = document.getElementById('sigFilter');
  const sigPause = document.getElementById('sigPause');
  let sigN = 0, paused = false;
  document.getElementById('clear').onclick = () => { sigLog.innerHTML=''; sigN=0; updateSigCount(); };
  sigPause.onclick = () => { paused = !paused; sigPause.textContent = paused ? 'Resume' : 'Pause'; sigPause.classList.toggle('on', paused); };
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // --- World pane: keep the last snapshot; filter client-side ---
  let worldData = [];
  const foesOnly = document.getElementById('foesOnly');
  worldFilter.oninput = renderWorld;
  foesOnly.onchange = renderWorld;
  function invText(o){
    const inv = o.inventory || {}; const keys = Object.keys(inv);
    if (!keys.length) return 'id '+o.id+'  ·  (no inventory)';
    return 'id '+o.id+'  ·  ' + keys.map(k => k+': '+JSON.stringify(inv[k])).join('   ');
  }
  function renderWorld() {
    const q = worldFilter.value.trim().toLowerCase();
    let rows = foesOnly.checked ? worldData.filter(o => o.enemy) : worldData;
    if (q) rows = rows.filter(o => ((o.name||'')+' '+(o.side||'')+' '+(o.kind||'')+' '+(o.roles||[]).join(' ')).toLowerCase().includes(q));
    const filtered = q || foesOnly.checked;
    worldCount.textContent = worldData.length ? (filtered ? '('+rows.length+'/'+worldData.length+')' : '('+worldData.length+')') : '';
    worldBody.innerHTML = rows.length ? rows.map((o,i) =>
      '<tr class="wrow" data-idx="'+i+'" title="Click to show inventory"><td>'+esc(o.name)+'</td><td>'+esc(o.side)+'</td><td>'+esc(o.kind)+'</td>'
      + '<td>'+(o.enemy ? '<span class="foe">enemy</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td class="muted">'+esc((o.roles||[]).join(', '))+'</td></tr>'
      + '<tr class="winv" data-inv="'+i+'" style="display:none"><td colspan="5" class="muted invcell"></td></tr>').join('')
      : '<tr><td colspan="5" class="empty">'+(worldData.length ? 'No matches.' : 'No space objects.')+'</td></tr>';
    worldBody.querySelectorAll('.wrow').forEach(r => r.onclick = () => {
      const inv = worldBody.querySelector('.winv[data-inv="'+r.dataset.idx+'"]');
      if (!inv) return;
      if (inv.style.display === 'none') { inv.querySelector('.invcell').textContent = invText(rows[+r.dataset.idx]); inv.style.display=''; }
      else inv.style.display = 'none';
    });
  }

  // --- Signals pane: filter by name; Pause freezes auto-scroll (still collecting) ---
  let sigShown = 0;
  function matchSig(row){ return !sigFilter.value.trim() || (row.dataset.name||'').toLowerCase().includes(sigFilter.value.trim().toLowerCase()); }
  function updateSigCount(){ sigCount.textContent = sigN ? (sigShown < sigN ? '('+sigShown+'/'+sigN+')' : '('+sigN+')') : ''; }
  sigFilter.oninput = () => { sigShown = 0; for (const r of sigLog.children) { const on = matchSig(r); r.style.display = on ? '' : 'none'; if (on) sigShown++; } updateSigCount(); };

  window.addEventListener('message', (e) => {
    const m = e.data; if (!m || !m.kind) return;
    if (m.kind === 'agents') {
      worldData = (m.payload && m.payload.agents) || [];
      renderWorld();
    } else if (m.kind === 'signal') {
      const p = m.payload || {};
      const row = document.createElement('div'); row.className = 'sig';
      row.dataset.name = p.name || '';
      const ts = new Date().toLocaleTimeString();
      row.innerHTML = '<span class="ts">'+esc(ts)+'</span><span class="name">'+esc(p.name)+'</span> <span class="muted">→ '+esc(p.routes)+' route(s)</span> '+esc(JSON.stringify(p.data||{}));
      const on = matchSig(row); row.style.display = on ? '' : 'none';
      sigLog.appendChild(row); sigN++; if (on) sigShown++;
      while (sigLog.childNodes.length > 500) { const g = sigLog.firstChild; if (g.style.display !== 'none') sigShown--; sigN--; sigLog.removeChild(g); }
      updateSigCount();
      if (on && !paused) row.scrollIntoView(false);
    } else if (m.kind === 'widgets') {
      const p = m.payload || {};
      wFrames[p.client] = p.widgets || [];
      syncClients();
      renderWidgets();
    } else if (m.kind === 'brains') {
      renderBrains((m.payload && m.payload.brains) || []);
    }
  });

  // --- Brains pane: render each agent's behaviour tree, marking the active node ---
  function renderBrains(brains) {
    const tree = document.getElementById('bTree');
    document.getElementById('bCount').textContent = brains.length ? '('+brains.length+')' : '';
    if (!brains.length) { tree.innerHTML = '<div class="empty">No agent brains.</div>'; return; }
    const lines = [];
    for (const b of brains) {
      lines.push('<div class="bagent">'+esc(b.name || b.agent)
        + (b.paused ? ' <span class="pz">(paused)</span>' : '')+'</div>');
      (function walk(node, depth) {
        if (!node) return;
        lines.push('<div class="bnode'+(node.active?' on':'')+'" style="padding-left:'+(10+depth*14)+'px">'
          + '<span class="btype">'+esc(node.type)+'</span> '+esc(node.label||'')
          + (node.result ? ' <span class="bres">['+esc(node.result)+']</span>' : '')+'</div>');
        for (const c of (node.children||[])) walk(c, depth+1);
      })(b.tree, 0);
    }
    tree.innerHTML = lines.join('');
  }

  // --- Widgets pane: build a tree from parent/tag and render it indented ---
  const wFrames = {};                 // client -> [widget]
  const wSel = document.getElementById('wClient');
  wSel.onchange = renderWidgets;
  function syncClients() {
    const ids = Object.keys(wFrames);
    const cur = wSel.value;
    wSel.innerHTML = ids.map(id => '<option value="'+esc(id)+'">console '+esc(id)+'</option>').join('');
    if (ids.indexOf(cur) >= 0) wSel.value = cur;
  }
  function fmtRect(r){ return (r && r.length===4) ? '['+r.map(n => Math.round(n*1000)/1000).join(', ')+']' : ''; }
  function renderWidgets() {
    const tree = document.getElementById('wTree');
    const widgets = wFrames[wSel.value] || [];
    document.getElementById('wCount').textContent = widgets.length ? '('+widgets.length+')' : '';
    if (!widgets.length) { tree.innerHTML = '<div class="empty">No widgets this frame.</div>'; return; }
    const kids = {};                  // parent tag -> [widget]
    const tags = new Set(widgets.map(w => w.tag).filter(Boolean));
    for (const w of widgets) { (kids[w.parent] = kids[w.parent] || []).push(w); }
    const roots = widgets.filter(w => !w.parent || !tags.has(w.parent));
    const seen = new Set(); const lines = [];
    (function walk(list, depth) {
      for (const w of list) {
        if (seen.has(w)) continue; seen.add(w);
        lines.push('<div class="wnode" style="padding-left:'+(10+depth*14)+'px">'
          + '<span class="wtype">'+esc(w.type)+'</span> '
          + '<span class="wtag">'+esc(w.tag||'')+'</span> '
          + '<span class="wrect">'+esc(fmtRect(w.rect))+'</span></div>');
        if (w.tag && kids[w.tag]) walk(kids[w.tag], depth+1);
      }
    })(roots, 0);
    tree.innerHTML = lines.join('');
  }
</script></body></html>`;
}

function showMissionInspector(column: vscode.ViewColumn = vscode.ViewColumn.Beside): void {
  if (missionInspectorPanel) { missionInspectorPanel.reveal(column, true); return; }
  missionInspectorPanel = vscode.window.createWebviewPanel(
    'amdMissionInspector', 'Mission Inspector',
    { viewColumn: column, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true });
  missionInspectorPanel.webview.html = missionInspectorHtml(inspectorNonce());
  missionInspectorPanel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === 'openTool') { openAmdTool(msg.tool, undefined, missionInspectorPanel?.viewColumn); }
  });
  missionInspectorPanel.onDidDispose(() => { missionInspectorPanel = undefined; });
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Artemis AMD');
  extensionUri = context.extensionUri;

  // Mission Inspector: open it on a mast session, and feed it mast/inspect events.
  // Remember the active .amd so document tools launched from a document-less
  // panel (the Mission Inspector) know which mission to open.
  if (vscode.window.activeTextEditor?.document.languageId === 'amd') {
    lastAmdUri = vscode.window.activeTextEditor.document.uri.toString();
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((ed) => {
    if (ed?.document.languageId === 'amd') { lastAmdUri = ed.document.uri.toString(); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('amd.showMissionInspector', () => showMissionInspector()));
  context.subscriptions.push(vscode.debug.onDidStartDebugSession((s) => {
    if (s.type === 'mast') { showMissionInspector(); }
  }));
  context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
    if (e.event === 'mast/inspect' && missionInspectorPanel) {
      void missionInspectorPanel.webview.postMessage(e.body);
    }
  }));

  // MAST source debugger.
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('mast', new MastDebugAdapterFactory()));
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('mast', new MastDebugConfigurationProvider()));
  // When a mast debug session ends, stop the runner the extension spawned for it.
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession((s) => {
    const child = missionRunners.get(s.id);
    if (child) {
      missionRunners.delete(s.id);
      output.appendLine('Stopping mission runner (debug session ended).');
      killTree(child.pid);
    }
  }));

  // Wrap so a title-bar/context-menu invocation's Uri arg isn't forwarded as our
  // (string) uriArg — a vscode.Uri would serialize to a dict and crash the server.
  context.subscriptions.push(vscode.commands.registerCommand('amd.showMap', () => showMap()));
  context.subscriptions.push(vscode.commands.registerCommand('amd.showGraph', () => showGraph()));
  context.subscriptions.push(vscode.commands.registerCommand('amd.showStoryOutline', () => showStoryOutline()));
  context.subscriptions.push(vscode.commands.registerCommand('amd.showResolver', () => showAmdResolver()));
  context.subscriptions.push(vscode.commands.registerCommand('amd.guiEditor', showGuiEditor));
  context.subscriptions.push(GuiFileEditorProvider.register());   // *.gui.mast opens as the GUI Editor
  // Toggle a *.gui.mast text editor back into the visual GUI Editor.
  context.subscriptions.push(vscode.commands.registerCommand('amd.openGuiEditor', (uri?: vscode.Uri) => {
    const target = uri || vscode.window.activeTextEditor?.document.uri;
    if (target) { void vscode.commands.executeCommand('vscode.openWith', target, 'amd.guiFileEditor'); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('amd.showPreview', showPreview));
  context.subscriptions.push(vscode.commands.registerCommand('amd.previewInSession', previewInSession));
  context.subscriptions.push(vscode.commands.registerCommand('amd.newFile', newContentFile));

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
  // Kill any preview mocks we started so they don't outlive the editor.
  for (const child of mockRunners.values()) { killTree(child.pid); }
  mockRunners.clear();
  return client?.stop();
}
