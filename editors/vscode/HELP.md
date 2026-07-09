# Artemis AMD — Help

Language support for Artemis Cosmos **AMD (`.amd`)** files in VS Code: syntax
highlighting, live error-checking, navigation, and formatting.

The extension is a thin client — the smart features come from the **AMD language
server** that ships with `sbs` (`sbs lint --lsp`). The extension launches it and
displays what it reports.

---

## Setup

1. **Point it at Cosmos — usually nothing to do.** The extension finds your
   Artemis Cosmos install automatically by walking up from the open `.amd` file
   (missions live inside the Cosmos tree), and runs the language server with that
   install's **bundled Python** and **`sbs.pyz`**. **`sbs` does not need to be on
   your PATH.** If your `.amd` files live outside a Cosmos install, set
   `amd.cosmosPath` to the install folder — the one containing `PyRuntime/` and
   `data/`.
2. **Install the extension** — either:
   - open `editors/vscode/` in VS Code and press **F5** (Extension Development
     Host), or
   - build a package and install it: `npm install && npm run package`, then
     `code --install-extension amd-language-<version>.vsix`.
3. Open any `.amd` file. Syntax highlighting appears immediately; the other
   features come online once the server starts.

> **Highlighting works even before the server starts.** Diagnostics, navigation,
> and formatting need the server — if it can't find Cosmos you'll get colors but no
> squiggles; set `amd.cosmosPath` (see [Settings](#settings)).

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
| **Quick fixes** | `Ctrl+.` on a warning — "Did you mean `X`?" / "Create node" | yes |
| **Reference CodeLens** | a clickable "N reference(s)" above each node | yes |
| **Color swatches** | an inline swatch + picker on any `#rrggbb` | yes |
| **Inlay hints** | a reference's target display name, ghosted inline | yes |
| **Format document** | `Shift+Alt+F`, or on save (see below) | yes |

### Mission map

Run **Artemis AMD: Show Mission Map** (Command Palette, or the button in the editor
title bar on a `.amd` file) to see your mission's geography: every landmark
(`At: i,j`) plotted on a grid, each region (`Center:` / `Radius:`) drawn as a tinted
disc in its `Color:`. **Click a landmark** to jump to its node. The map spans the
whole mission's `.amd` files, so a landmark defined in any file shows up.

**Edit:** **drag a landmark** to a new cell to move it — its `At:` is rewritten in
the `.amd` (undoable with Ctrl+Z, and the map re-renders); a plain click still jumps
to the node. **Double-click an empty cell** to create a new landmark stub there.
**Right-click a landmark** to **Rename** it (mission-wide — every reference follows),
**Change Kind**, **Delete**, or **Go to**. **Regions** get two handles: drag the
**centre dot** to move the region (rewrites `Center:`) and the **edge dot** to resize
it (rewrites `Radius:`).

Navigation (both this and the graph): the view **opens fitted** to the window;
**zoom** with the buttons or **Ctrl+scroll**, **Fit** again anytime, **drag the
canvas** to pan, and toggle the **Overview** minimap (bottom-right) — click it to
jump anywhere.

### Story graph

Run **Artemis AMD: Show Story Graph** to see how your content connects: every node
and the links between them — choices, `Scene:`, `Then: reveal`, and `Parent:` — laid
out left-to-right, colored by kind, and grouped by section. **Click a node** to jump
to it. **Drag from one node onto another** to add a choice link — it writes
`- [target](key)` into the source node's body (undoable). **Right-click a node** to
**Focus here** (see just the flow reachable from it), **Rename** it (the key changes
across the whole mission — every reference follows), **Delete** it, or **Go to** it.
**Right-click a link** to **Delete** it or **Rewire** it to a different node.

**Focus mode** trims the overview to one flow: pick **Focus here** on a node and the
graph re-lays-out only the nodes reachable from it — ideal for following a single
conversation or quest chain. The **← Show all** button (top-left) returns to the
whole mission. **Hover a node** to
spotlight it and its direct links (everything else dims), and **filter by section**
with the toolbar checkboxes (focus on just dialogue, or just quests). Great for spotting dead-end dialogue, unreachable quests, and the
overall shape of a conversation. Same navigation as the map — fit-on-open, zoom, Fit,
drag-to-pan, and the Overview minimap.

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
| `unfired-signal` | A quest `When: signal X` waits on a signal nothing emits. |
| `non-ascii` | Non-ASCII text (smart quotes, em-dashes, emoji) — the engine renders ASCII only, so it misrenders or crashes. Comments are exempt. |
| `suspect-heading` | A `#` heading has brackets but no `(key)` — maybe an intended heading missing its key. |

References resolve across **all of a mission's `.amd` files** and against MAST
`== labels ==`, so pointing at a node in another file (or a MAST handler label) is
fine. If the checker can't see a signal you emit dynamically, vouch for it with an
`emits: [name]` (or `handles: [name]`) line in any `metadata:` block.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| `amd.cosmosPath` | `""` (auto) | Your Artemis Cosmos install folder (the one with `PyRuntime/` and `data/`). Empty = auto-detect by walking up from the open file. |
| `amd.server.command` | `""` | Advanced override for the launch command. Empty = use the detected Cosmos install (its Python + `sbs.pyz`), falling back to `sbs` on PATH. |
| `amd.server.args` | `["lint", "--lsp"]` | Arguments that start the server on stdio. |

**How the launch is chosen:** an explicit `amd.server.command` wins; otherwise the
detected Cosmos install (`<cosmos>/PyRuntime/python <cosmos>/data/missions/sbs.pyz
lint --lsp`); otherwise `sbs` on PATH.

**Run the server directly** (bypassing `sbs`), e.g. for development:

```json
"amd.server.command": "python",
"amd.server.args": ["-m", "sbs_utils.procedural.amd_lsp"]
```

(with `sbs_utils` importable by that Python).

---

## Troubleshooting

**Colors but no squiggles / no navigation.** The server isn't starting. Open
**View → Output**, pick **"Artemis AMD"** from the dropdown, and read the log — it
prints which Cosmos install (and Python) it found, or why it couldn't. Most often
the `.amd` file is outside a Cosmos install, so auto-detect fails — set
`amd.cosmosPath` to the install folder (with `PyRuntime/` and `data/`); the server
restarts automatically when you save the setting.

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
