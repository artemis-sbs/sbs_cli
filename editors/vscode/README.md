# Artemis AMD — VSCode extension

Language support for Artemis Cosmos **AMD (`.amd`)** files.

This extension is **thin by design**. It contributes:

- **Syntax highlighting** for `.amd` (a TextMate grammar) — the one thing done in
  the editor.
- A **language client** that launches the AMD language server (`sbs lint --lsp`)
  and speaks LSP to it. Everything smart comes from that server:
  - live **diagnostics** (broken headings, unclosed `---` fences, dangling
    `choice`/`Scene`/`reveal`/`Parent` targets, signals with no route, `reach`
    cells with no landmark),
  - **go-to-definition** (a `reveal` / choice / `Scene:` target → its node),
  - a **document outline** of the heading tree,
  - **hover** and **completion** of node keys,
  - **format-on-save** (the canonical AMD formatter).

Because the intelligence lives in the server, the same brain serves every editor —
Neovim, Emacs, Sublime, JetBrains all point their LSP client at `sbs lint --lsp`.

## Requirements

The `sbs` tool must be on your `PATH` (or set `amd.server.command` to its full
path). The server ships inside `sbs_utils` (`sbs_utils.procedural.amd_lsp`), so a
current `sbs.pyz` / rereleased `sbs_utils` is all you need.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `amd.server.command` | `sbs` | Program that starts the server |
| `amd.server.args` | `["lint", "--lsp"]` | Args to start it on stdio |

To bypass `sbs` and run the module directly, set `amd.server.command` to your
Python and `amd.server.args` to `["-m", "sbs_utils.procedural.amd_lsp"]` (with
`sbs_utils` importable).

## Build / install (not prebuilt)

This folder is source only — no compiled `out/` or `.vsix` is committed.

```
cd editors/vscode
npm install
npm run compile          # tsc -> out/extension.js
npm run package          # vsce package -> amd-language-<version>.vsix
code --install-extension amd-language-0.1.0.vsix
```

Or press **F5** in VSCode with this folder open to launch an Extension Development
Host for iterating.

## Known limitations (v0.1)

- After editing a `.mast` file, open `.amd` documents aren't automatically
  re-checked (the server re-reads `.mast` on the next `.amd` edit). A watched-file
  re-lint is a planned follow-on.
- Cross-file signal checks only see `.mast` under the mission folder; signals
  routed solely in external mastlibs may show as warnings.
