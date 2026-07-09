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
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  Executable,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;
let output: vscode.OutputChannel;

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
interface MapLandmark { key: string; display: string; i: number; j: number; kind: string; uri: string; line: number; atRange: LspRange | null; }
interface MapRegion { key: string; display: string; i: number; j: number; radius: number; color: string; uri: string; line: number; }
interface MissionMap { landmarks: MapLandmark[]; regions: MapRegion[]; }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Shared webview shell: a fixed toolbar (title, legend, fit/overview/zoom) over a
// bounded scroll area (real scrollbars), with zoom (buttons + Ctrl+wheel), fit-to-
// window, drag-to-pan, and a minimap overview. `.lm`/`.nd` are click-to-jump.
// `extraScript` is appended for view-specific behaviour (e.g. graph highlighting).
function webviewPage(title: string, legend: string, styles: string, body: string, nonce: string, extraScript = ''): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const scroll = document.getElementById('scroll');
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
    updateMini();
  }
  document.getElementById('zin').onclick = () => setZoom(zoom * 1.2);
  document.getElementById('zout').onclick = () => setZoom(zoom / 1.2);
  zreset.onclick = () => setZoom(1);
  function doFit() { if (svg) { setZoom(Math.min((scroll.clientWidth - 16) / baseW, (scroll.clientHeight - 16) / baseH)); } }
  document.getElementById('bfit').onclick = doFit;
  document.getElementById('bmini').onclick = () => { miniWrap.classList.toggle('hidden'); updateMini(); };
  scroll.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); const r = scroll.getBoundingClientRect(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX - r.left, e.clientY - r.top); } }, { passive: false });
  scroll.addEventListener('scroll', updateMini);
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

  // --- click to jump (suppressed after a drag) ---
  for (const g of scroll.querySelectorAll('.lm, .nd')) {
    g.addEventListener('click', () => { if (moved) { return; } vscode.postMessage({ type: 'goto', uri: g.dataset.uri, line: parseInt(g.dataset.line, 10) }); });
  }

  buildMini(); apply();
  // fit on open if the content is larger than the viewport
  requestAnimationFrame(() => { if (svg && (baseW > scroll.clientWidth || baseH > scroll.clientHeight)) { doFit(); } });
  ${extraScript}
</script></body></html>`;
}

function renderMap(map: MissionMap, nonce: string): string {
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
  // regions (translucent discs)
  for (const r of map.regions) {
    const col = /^#[0-9a-fA-F]{3,8}$/.test(r.color) ? r.color : '#88aaff';
    svg += `<circle cx="${x(r.i)}" cy="${y(r.j)}" r="${r.radius * cell}" fill="${col}" fill-opacity="0.15" stroke="${col}" stroke-opacity="0.5"/>`;
    svg += `<text x="${x(r.i)}" y="${y(r.j) - r.radius * cell + 14}" class="rlabel">${esc(r.display)}</text>`;
  }
  // landmarks (clickable; draggable when we have the editable At: range)
  for (const l of map.landmarks) {
    const drag = l.atRange ? ` data-i="${l.i}" data-j="${l.j}" data-atrange='${JSON.stringify(l.atRange)}'` : '';
    svg += `<g class="lm${l.atRange ? ' draggable' : ''}" data-uri="${esc(l.uri)}" data-line="${l.line}"${drag}>`
      + `<circle cx="${x(l.i)}" cy="${y(l.j)}" r="6" class="dot"/>`
      + `<text x="${x(l.i) + 9}" y="${y(l.j) + 4}" class="llabel">${esc(l.display)} (${l.i},${l.j})</text>`
      + `</g>`;
  }
  svg += `</svg>`;

  const styles = `
  .grid { stroke: var(--vscode-editorIndentGuide-background, #8884); stroke-width: 1; }
  .dot { fill: var(--vscode-charts-orange, #e8a); stroke: var(--vscode-editor-background); stroke-width: 1.5; }
  .llabel { fill: var(--vscode-foreground); font-size: 11px; }
  .rlabel { fill: var(--vscode-descriptionForeground, #aaa); font-size: 11px; text-anchor: middle; }
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
    g.addEventListener('mousedown', (e) => { e.stopPropagation(); dragging = true; moved = false; dx0 = e.clientX; dy0 = e.clientY; });
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
  // Double-click an empty cell to create a landmark there.
  scroll.addEventListener('dblclick', (e) => {
    if (!svg || (e.target && e.target.closest && e.target.closest('.lm'))) { return; }
    const r = svg.getBoundingClientRect();
    const ux = (e.clientX - r.left) / zoom, uy = (e.clientY - r.top) / zoom;
    const i = Math.round((ux - GRID.cell / 2) / GRID.cell) + GRID.minI;
    const j = Math.round((uy - GRID.cell / 2) / GRID.cell) + GRID.minJ;
    vscode.postMessage({ type: 'addLandmark', i: i, j: j });
  });
  `;
  return webviewPage(title, '', styles, body, nonce, extraScript);
}

async function openLocation(uriStr: string, line: number): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const pos = new vscode.Position(Math.max(0, line), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  } catch (e) {
    output.appendLine(`Could not open ${uriStr}: ${e}`);
  }
}

// --- Story graph preview ----------------------------------------------------
interface GraphNode { key: string; display: string; section: string; uri: string; line: number; addLine: number; }
interface GraphEdge { from: string; to: string; kind: string; }
interface MissionGraph { nodes: GraphNode[]; edges: GraphEdge[]; }

function sectionHue(s: string): number {
  let h = 0;
  for (const c of s) { h = (h * 31 + c.charCodeAt(0)) % 360; }
  return h;
}

const EDGE_COLOR: Record<string, string> = {
  choice: '#7aa2f7', scene: '#9ece6a', reveal: '#e0af68', parent: '#bb9af7',
};

function renderGraph(graph: MissionGraph, nonce: string): string {
  const NW = 190, NH = 30, HGAP = 90, VGAP = 16;
  // depth = longest-path layer (cycle-safe: relax at most N times)
  const depth = new Map<string, number>(graph.nodes.map((n) => [n.key, 0]));
  for (let it = 0; it < graph.nodes.length; it++) {
    let changed = false;
    for (const e of graph.edges) {
      const nd = (depth.get(e.from) ?? 0) + 1;
      if ((depth.get(e.to) ?? 0) < nd) { depth.set(e.to, nd); changed = true; }
    }
    if (!changed) { break; }
  }
  const cols = new Map<number, GraphNode[]>();
  for (const n of graph.nodes) {
    const d = depth.get(n.key) ?? 0;
    if (!cols.has(d)) { cols.set(d, []); }
    cols.get(d)!.push(n);
  }
  const pos = new Map<string, { x: number; y: number }>();
  const depths = [...cols.keys()].sort((a, b) => a - b);
  let maxRows = 0;
  depths.forEach((d, ci) => {
    const arr = cols.get(d)!;
    arr.forEach((n, r) => pos.set(n.key, { x: ci * (NW + HGAP) + 20, y: r * (NH + VGAP) + 40 }));
    maxRows = Math.max(maxRows, arr.length);
  });
  const W = depths.length * (NW + HGAP) + 40;
  const H = Math.max(maxRows * (NH + VGAP) + 60, 120);

  const clip = (s: string) => (s.length > 26 ? s.slice(0, 25) + '…' : s);
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (const e of graph.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) { continue; }
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, mx = (x1 + x2) / 2;
    svg += `<path class="edge" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="${EDGE_COLOR[e.kind] || '#888'}" stroke-width="1.5" opacity="0.65"/>`;
  }
  for (const n of graph.nodes) {
    const p = pos.get(n.key)!;
    const h = sectionHue(n.section);
    svg += `<g class="nd" data-key="${esc(n.key)}" data-display="${esc(n.display)}" data-section="${esc(n.section)}" data-uri="${esc(n.uri)}" data-line="${n.line}" data-addline="${n.addLine}" data-cx="${p.x + NW}" data-cy="${p.y + NH / 2}">`
      + `<rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="6" fill="hsl(${h},45%,28%)" stroke="hsl(${h},60%,55%)"/>`
      + `<text x="${p.x + 8}" y="${p.y + 19}" class="nlabel">${esc(clip(n.display))}</text>`
      + `</g>`;
  }
  svg += `</svg>`;

  const sections = [...new Set(graph.nodes.map((n) => n.section))].sort();
  const legend = Object.entries(EDGE_COLOR)
    .map(([k, c]) => `<span class="leg"><i style="background:${c}"></i>${k}</span>`).join('')
    + sections.map((s) => `<label class="filt"><input type="checkbox" checked data-section="${esc(s)}"> ${esc(s)}</label>`).join('');

  const styles = `
  .nlabel { fill: #fff; font-size: 11px; }
  .nd { cursor: pointer; }
  .nd:hover rect { stroke-width: 2.5; }
  .filt { font-size: 11px; margin-right: 8px; color: var(--vscode-descriptionForeground); cursor: pointer; }
  .filt input { vertical-align: middle; margin-right: 2px; }`;
  const title = `Story Graph — ${graph.nodes.length} node(s), ${graph.edges.length} link(s)`;
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
  function applyFilter() {
    const hidden = new Set([...document.querySelectorAll('.filt input:not(:checked)')].map((c) => c.dataset.section));
    const hiddenKeys = new Set();
    for (const n of gnodes) { const off = hidden.has(n.dataset.section); n.style.display = off ? 'none' : ''; if (off) hiddenKeys.add(n.dataset.key); }
    for (const p of edges) { p.style.display = (hiddenKeys.has(p.dataset.from) || hiddenKeys.has(p.dataset.to)) ? 'none' : ''; }
  }
  for (const c of document.querySelectorAll('.filt input')) { c.addEventListener('change', applyFilter); }

  // Drag from one node to another to add a choice edge (- [display](target)).
  let connecting = null, tmpLine = null;
  for (const n of gnodes) {
    n.addEventListener('mousedown', (e) => {
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
  `;
  return webviewPage(title, legend, styles, body, nonce, extraScript);
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
    'amdGraph', 'AMD Story Graph', vscode.ViewColumn.Beside, { enableScripts: true },
  );
  const nonce = () => String(Date.now()) + Math.random().toString(36).slice(2);
  panel.webview.html = renderGraph(graph, nonce());

  const refresh = async () => {
    try {
      const g = await client!.sendRequest<MissionGraph>('amd/graph', { textDocument: { uri } });
      panel.webview.html = renderGraph(g, nonce());
    } catch (e) { output.appendLine(`Graph refresh failed: ${e}`); }
  };

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === 'goto') {
      openLocation(msg.uri, msg.line);
    } else if (msg?.type === 'connect' && msg.toKey) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(vscode.Uri.parse(msg.uri), new vscode.Position(msg.addLine, 0),
        `- [${msg.toDisplay}](${msg.toKey})\n`);
      await vscode.workspace.applyEdit(edit);
      await refresh();
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
    'amdMap', 'AMD Mission Map', vscode.ViewColumn.Beside, { enableScripts: true },
  );
  const nonce = () => String(Date.now()) + Math.random().toString(36).slice(2);
  panel.webview.html = renderMap(map, nonce());

  const refresh = async () => {
    try {
      const m = await client!.sendRequest<MissionMap>('amd/map', { textDocument: { uri } });
      panel.webview.html = renderMap(m, nonce());
    } catch (e) { output.appendLine(`Map refresh failed: ${e}`); }
  };

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === 'goto') {
      openLocation(msg.uri, msg.line);
    } else if (msg?.type === 'setAt' && msg.range) {
      const edit = new vscode.WorkspaceEdit();
      const r = msg.range;
      edit.replace(vscode.Uri.parse(msg.uri),
        new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character),
        `${msg.i}, ${msg.j}`);
      await vscode.workspace.applyEdit(edit);
      await refresh();   // re-render at the new position
    } else if (msg?.type === 'addLandmark') {
      const d = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      const key = `landmark_${msg.i}_${msg.j}`.replace(/-/g, 'm');
      const stub = `\n### [New Landmark](${key})\n---\nAt: ${msg.i}, ${msg.j}\nKind: derelict\n---\n`;
      const edit = new vscode.WorkspaceEdit();
      edit.insert(vscode.Uri.parse(uri), new vscode.Position(d.lineCount, 0), stub);
      await vscode.workspace.applyEdit(edit);
      await refresh();
    }
  });
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Artemis AMD');

  context.subscriptions.push(vscode.commands.registerCommand('amd.showMap', showMap));
  context.subscriptions.push(vscode.commands.registerCommand('amd.showGraph', showGraph));

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
