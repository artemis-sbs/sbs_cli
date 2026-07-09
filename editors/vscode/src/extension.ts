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

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Artemis AMD');

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
