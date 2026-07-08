# Artemis AMD — Help

Language support for Artemis Cosmos **AMD (`.amd`)** files in VS Code: syntax
highlighting, live error-checking, navigation, and formatting.

The extension is a thin client — the smart features come from the **AMD language
server** that ships with `sbs` (`sbs lint --lsp`). The extension launches it and
displays what it reports.

---

## Setup

1. **Install `sbs`** and make sure it's on your `PATH` (the extension runs
   `sbs lint --lsp`). Check with `sbs version` in a terminal. If it isn't on
   `PATH`, set `amd.server.command` to its full path (see [Settings](#settings)).
2. **Install the extension** — either:
   - open `editors/vscode/` in VS Code and press **F5** (Extension Development
     Host), or
   - build a package and install it: `npm install && npm run package`, then
     `code --install-extension amd-language-<version>.vsix`.
3. Open any `.amd` file. Syntax highlighting appears immediately; the other
   features come online once the server starts.

> **Syntax highlighting works without `sbs`.** Diagnostics, navigation, and
> formatting need the server, so if `sbs` isn't found you'll get colors but no
> squiggles — fix `amd.server.command`.

---

## Features

| Feature | How to use | Needs the server |
|---|---|---|
| **Syntax highlighting** | automatic on `.amd` | no |
| **Live diagnostics** | red/yellow squiggles + Problems panel (`Ctrl+Shift+M`) | yes |
| **Go to definition** | `F12` on a `reveal` / choice / `Scene:` target | yes |
| **Find all references** | `Shift+F12` on a node key | yes |
| **Rename symbol** | `F2` on a node key — updates the heading and every reference | yes |
| **Outline / breadcrumbs** | Outline view, or `Ctrl+Shift+O` to jump by heading | yes |
| **Hover** | hover a reference to preview its target | yes |
| **Completion** | `Ctrl+Space` — offers node keys | yes |
| **Format document** | `Shift+Alt+F`, or on save (see below) | yes |

### Format on save

The extension provides a formatter (whitespace, heading spacing, `---` fences,
blank-line runs — it never reflows your prose and never changes meaning). To run
it automatically for AMD files, add to your VS Code `settings.json`:

```json
"[amd]": {
  "editor.formatOnSave": true
}
```

---

## What the checker flags

**Errors** (they mean the file won't parse as intended):

| Code | Meaning |
|---|---|
| `broken-heading` | A heading looks like `# [Display](key)` but the link is malformed (e.g. a missing `)`), so the node silently becomes body text and vanishes. |
| `unclosed-data-fence` | A `---` metadata block was opened but never closed; the rest of the file is swallowed. |
| `heading-level-jump` | A heading skips a level (e.g. `#` then `###`) with no `##` between. |

**Warnings** (likely mistakes — a typo or a missing piece):

| Code | Meaning |
|---|---|
| `dangling-choice` | A choice `- [text](target)` points at a node that doesn't exist. |
| `dangling-scene` | A lifeform's `Scene:` points at a dialogue node that doesn't exist. |
| `dangling-reveal` | A quest `Then: reveal <path>` points at a node/path that doesn't exist. |
| `dangling-parent` | A `Parent:` points at a node that doesn't exist. |
| `signal-no-route` | The file emits `signal X` but nothing handles it (`//signal/X`). |
| `unfired-signal` | A quest `When: signal X` (or `Fail on signal:`) waits on a signal nothing emits. |
| `suspect-heading` | A `#` heading has brackets but no `(key)` — maybe an intended heading missing its key. |

References resolve across **all of a mission's `.amd` files** and against MAST
`== labels ==`, so pointing at a node in another file (or a MAST handler label) is
fine. If the checker can't see a signal you emit dynamically, vouch for it with an
`emits: [name]` (or `handles: [name]`) line in any `metadata:` block.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| `amd.server.command` | `sbs` | Program that launches the language server. Set to the full path to `sbs` / `sbs.bat` if it isn't on `PATH`. |
| `amd.server.args` | `["lint", "--lsp"]` | Arguments to start the server on stdio. |

**Run the server directly** (bypassing `sbs`), e.g. for development:

```json
"amd.server.command": "python",
"amd.server.args": ["-m", "sbs_utils.procedural.amd_lsp"]
```

(with `sbs_utils` importable by that Python).

---

## Troubleshooting

**Colors but no squiggles / no navigation.** The server isn't starting. Open
**View → Output**, pick **"Artemis AMD"** from the dropdown, and read the log. Most
often `sbs` isn't on `PATH` — set `amd.server.command` to its full path and reload
the window (`Ctrl+Shift+P → Developer: Reload Window`).

**Nothing happens on a `.amd` file at all.** Confirm the file is recognized as AMD:
the language indicator in the status bar (bottom-right) should say **AMD**. If not,
click it and pick AMD, or check the file really ends in `.amd`.

**A cross-file reference is flagged but it's valid.** The server resolves across
the whole mission when it can find the mission root (a folder with `story.json` /
`story.mast` / `__lib__.json` above the file). If a `.amd` lives outside any such
folder it's checked on its own, so cross-file targets show as dangling — open it
within its mission, or run `sbs lint <mission>` to validate every `.amd` together.

**"After I edit a `.mast` file the `.amd` warnings are stale."** The server
re-reads `.mast` on the next `.amd` edit — make any edit in the `.amd` (or reload
the window) to refresh.

**Format-on-save isn't running.** Make sure `"[amd]": { "editor.formatOnSave": true }`
is in your settings, and that no other formatter is set as default for AMD.

---

## Also on the command line

The same checks run headlessly — handy for CI or a quick pass:

```
sbs lint <mission>            # human-readable report, exit 0/1
sbs lint <mission> --strict   # fail on warnings too
sbs lint <mission> --format json   # structured output for tools
sbs fmt  <mission>            # format all .amd (or --check for CI)
```

See the main [README](README.md) for build/packaging details.
