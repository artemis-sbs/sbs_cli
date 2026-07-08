// Artemis AMD - VSCode language client.
//
// This extension is deliberately thin: all language intelligence (diagnostics,
// go-to-definition, outline, hover, completion, formatting) lives in the Python
// AMD language server, which it launches as `sbs lint --lsp` and speaks LSP to
// over stdio. Syntax highlighting is the one thing done client-side, via the
// TextMate grammar in syntaxes/amd.tmLanguage.json.

import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  Executable,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function activate(_context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration('amd');
  const command = cfg.get<string>('server.command', 'sbs');
  const args = cfg.get<string[]>('server.args', ['lint', '--lsp']);

  // shell:true on Windows so a `sbs.bat` on PATH resolves.
  const exec: Executable = {
    command,
    args,
    options: { shell: process.platform === 'win32' },
  };
  const serverOptions: ServerOptions = { run: exec, debug: exec };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'amd' }],
    // The server re-reads a mission's .mast on each check; watching them lets an
    // editor nudge it after cross-file edits.
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.mast'),
    },
  };

  client = new LanguageClient('amd', 'Artemis AMD', serverOptions, clientOptions);
  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
