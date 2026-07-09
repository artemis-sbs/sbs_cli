# Artemis AMD — VSCode extension

Language support for Artemis Cosmos **AMD (`.amd`)** files.

> **Using the extension?** See **[HELP.md](HELP.md)** for the full usage guide —
> features, settings, the diagnostic codes, and troubleshooting. This README is
> about building/installing it.

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

An **Artemis Cosmos install** — that's it. The extension finds it automatically
(walking up from the open `.amd` file, since missions live inside the Cosmos tree)
and runs the server with the install's bundled Python and `sbs.pyz`. **`sbs` need
not be on your PATH.** If your files live outside a Cosmos install, set
`amd.cosmosPath` to the install folder.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `amd.cosmosPath` | `""` (auto) | Cosmos install folder (with `PyRuntime/` + `data/`); empty = auto-detect |
| `amd.server.command` | `""` | Advanced override for the launch command; empty = use Cosmos, else `sbs` on PATH |
| `amd.server.args` | `["lint", "--lsp"]` | Args to start the server on stdio |

Launch order: explicit `amd.server.command` → detected Cosmos (`PyRuntime/python
sbs.pyz lint --lsp`) → `sbs` on PATH. See [HELP.md](HELP.md) for details.

## Build / install (not prebuilt)

This folder is source only — no compiled `out/` or `.vsix` is committed. The build
below is verified to compile (`tsc`) and package (`vsce`) cleanly on Node 24 / npm 10.

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
