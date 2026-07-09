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
interface MapLandmark { key: string; display: string; i: number; j: number; kind: string; uri: string; line: number; }
interface MapRegion { key: string; display: string; i: number; j: number; radius: number; color: string; uri: string; line: number; }
interface MissionMap { landmarks: MapLandmark[]; regions: MapRegion[]; }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  // landmarks (clickable)
  for (const l of map.landmarks) {
    svg += `<g class="lm" data-uri="${esc(l.uri)}" data-line="${l.line}">`
      + `<circle cx="${x(l.i)}" cy="${y(l.j)}" r="6" class="dot"/>`
      + `<text x="${x(l.i) + 9}" y="${y(l.j) + 4}" class="llabel">${esc(l.display)} (${l.i},${l.j})</text>`
      + `</g>`;
  }
  svg += `</svg>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; padding: 10px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
  .grid { stroke: var(--vscode-editorIndentGuide-background, #8884); stroke-width: 1; }
  .dot { fill: var(--vscode-charts-orange, #e8a); stroke: var(--vscode-editor-background); stroke-width: 1.5; }
  .llabel { fill: var(--vscode-foreground); font-size: 11px; }
  .rlabel { fill: var(--vscode-descriptionForeground, #aaa); font-size: 11px; text-anchor: middle; }
  .lm { cursor: pointer; }
  .lm:hover .dot { fill: var(--vscode-charts-yellow, #fd6); }
  .empty { color: var(--vscode-descriptionForeground); }
  h3 { margin: 0 0 8px; font-weight: 600; }
</style></head><body>
<h3>Mission Map — ${map.landmarks.length} landmark(s), ${map.regions.length} region(s)</h3>
${pts.length ? `<div style="overflow:auto">${svg}</div>` : '<p class="empty">No landmarks or regions found in this mission.</p>'}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  for (const g of document.querySelectorAll('.lm')) {
    g.addEventListener('click', () => vscode.postMessage({ type: 'goto', uri: g.dataset.uri, line: parseInt(g.dataset.line, 10) }));
  }
</script></body></html>`;
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
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  panel.webview.html = renderMap(map, nonce);
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === 'goto') {
      openLocation(msg.uri, msg.line);
    }
  });
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Artemis AMD');

  context.subscriptions.push(vscode.commands.registerCommand('amd.showMap', showMap));

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
