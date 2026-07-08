# sbs — the Artemis Cosmos command-line helper

`sbs` is a small tool that lives next to your Artemis Cosmos missions. It does the
chores around missions so you don't have to: **downloading** missions from the
internet, **launching** the game (one window or a whole bridge full of them),
**test-flying** a mission in your web browser, and — if you write missions —
**packaging** them up to share.

You type commands like `sbs fetch SecretMeeting` or `sbs run helm,comms`. That's
the whole idea.

> **New here?** You only need three commands to start: `sbs production` (get the
> stock missions), `sbs fetch <name>` (get one specific mission), and `sbs run`
> (play). Everything below that is for people who *make* missions.

---

## Getting the tool running

The tool ships as a single file, `sbs.pyz` (a self-contained Python program),
that sits in your `missions` folder. A companion `sbs.bat` runs it using the
copy of Python that comes with Artemis Cosmos, so you don't have to install
anything.

- Open a command prompt in your `missions` folder.
- Type **`sbs --help`** to see every command.
- Type **`sbs <command> --help`** to see the options for one command
  (e.g. `sbs fetch --help`).

*(If you happen to have your own Python installed, `sbs.pyz --help` works too.)*

To update the tool itself to the newest version:

```
sbs update
```

To see which version you have:

```
sbs version
```

---

## For players — getting and running missions

### `sbs production` — get everything that ships with Cosmos

Downloads a fresh copy of all the missions that come with Artemis Cosmos
(Legendary Missions, Secret Meeting, Walk The Line, and friends). It **replaces**
your existing copies with clean ones.

```
sbs production          # asks before wiping your mission folders
sbs production -q       # "quiet" — skips the "are you sure?" question
```

> **Heads up:** this removes your current mission folders and re-downloads them.
> If you've been editing a mission, copy it somewhere safe first.

### `sbs fetch` — get one specific mission

Downloads a single mission (and anything it depends on) from GitHub.

```
sbs fetch SecretMeeting                    # grab the Secret Meeting mission
sbs fetch WalkTheLine,SecretMeeting        # grab several at once (comma-separated)
sbs fetch SomeMission --user their_name     # grab a mission from someone other than artemis-sbs
sbs fetch LegendaryMissions --branch v1.3.0 # grab a specific version (tag) instead of the latest
```

By default `fetch` pulls from the official `artemis-sbs` account and the newest
(`main`) version. Common options:

| Option | What it does |
|---|---|
| `-u`, `--user` | Whose GitHub account to download from (default `artemis-sbs`) |
| `-b`, `--branch` | Which version/branch to download (default `main` = latest) |
| `-o`, `--overwrite_libs` | Re-download the shared library files even if you already have them |
| `-q`, `--quiet` | Don't ask before replacing existing folders |

Fetch is smart about dependencies: it looks inside the mission for a list of the
shared libraries it needs and downloads any you're missing.

### `sbs run` — launch the game

Opens one or more copies of Artemis Cosmos, each set to a specific console, and
tidily arranges the windows on your screen. Great for playing solo across
several stations, or for testing.

```
sbs run helm,comms              # two windows: one Helm, one Comms
sbs run server,helm,comms       # a server plus two consoles
sbs run mainscreen,helm         # a main screen and a helm station
sbs run                         # six windows (server + comms/weapons/science/
                                # engineering/cinematic) — a full test bridge
```

Just list the consoles you want, separated by commas.

---

## For mission writers — try your mission without a full crew

You don't need a room full of bridge stations (or even the game itself running)
to see your mission come to life. These commands run a mission in a lightweight
simulator and show it **in your web browser**.

### `sbs debug` — test-fly a mission in the browser

Runs a mission and opens a browser-based view of it. You can watch the story
play out, click buttons, and see the map — all from one window.

```
sbs debug .                     # run the mission in the current folder; show the map picker
sbs debug . --map 0             # skip the picker and jump straight into the first map
sbs debug . --map SecretMeeting # jump into a map by name
sbs debug . --no-gui            # run it with no browser window (just checks it works)
```

Once it's running, open **http://localhost:8765/** in your browser.

You can also nudge the mission's settings from the command line without editing
any files — handy for quickly trying "what if there were 3 players?" or "what if
the difficulty were maxed?":

```
sbs debug . --players 1 --auto-start          # 1 player, start immediately
sbs debug . --set DIFFICULTY=8                 # crank difficulty to 8
sbs debug . --auto-start --autoplay --players 1 # let the mission play itself
```

| Option | What it does |
|---|---|
| `--map <n or name>` | Jump straight into a map instead of showing the picker |
| `--no-gui` | Run without the browser view (a quiet "does it start?" check) |
| `--players N` | Pretend there are N player ships |
| `--auto-start` | Begin the mission right away |
| `--autoplay` | Let the mission drive itself (no human needed) |
| `--set KEY=VALUE` | Override any setting (repeatable), e.g. `--set DIFFICULTY=8` |
| `--port` | Which browser port to use (default 8765) |

### `sbs web` — show a mission's web pages in a browser

Some missions publish live pages — a scoreboard, a captain's log, a status
dashboard — meant to be viewed in a browser while the game runs. `sbs web`
serves those pages. Start it, then open the page in any browser or on another
device on your network.

```
sbs web .                       # serve the current mission's pages
sbs web LegendaryMissions       # serve a specific mission's pages
```

Then visit **http://127.0.0.1:8770/web/<page-name>**. This connects to a game
that's *already running* with debugging turned on — start `sbs web` before or
after the game; it reconnects on its own.

### `sbs web-static` — save a page as a plain HTML file

Takes one of those web pages and saves it as a single, self-contained `.html`
file you can email, post, or open later — a snapshot, frozen in time.

```
sbs web-static . scores -o scores.html
```

### `sbs overnight` — leave a mission running to shake out bugs

Runs a mission over and over by itself for hours ("soak testing"), which
surfaces the rare problems that only show up after a long play session. Mostly
used by developers, but simple to start:

```
sbs overnight LegendaryMissions --hours 8      # run itself for 8 hours
sbs overnight LegendaryMissions --map 0 --gui  # watch it in the browser as it goes
```

---

## For mission makers — building and packaging

When you edit a mission, some parts (shared libraries and add-ons) need to be
"packaged" into zip files before the game will pick up your changes. These
commands handle that.

### `sbs lib` — build a mission's libraries/add-ons once

Looks for a `__lib__.json` file describing what to package, and builds it.

```
sbs lib LegendaryMissions
sbs lib LegendaryMissions -u my_name    # package under your own GitHub name
```

### `sbs watch` — rebuild automatically as you edit

The friendliest option: leave it running, and every time you save a change it
rebuilds the affected libraries for you. No more "did I forget to rebuild?"

```
sbs watch LegendaryMissions                     # watch and rebuild one mission
sbs watch sbs_utils,LegendaryMissions           # watch several at once
sbs watch my_name:LegendaryMissions             # build under a different GitHub name
sbs watch LegendaryMissions --interval 2        # check for changes every 2 seconds (default 5)
```

Use `name:` before a folder (like `my_name:LegendaryMissions`) when you have your
own fork and your mission's `story.json` refers to it by that name.

### `sbs compile` — check a mission for script errors

Reads through a mission's script and reports any mistakes, without launching the
whole game.

```
sbs compile LegendaryMissions           # check for errors
sbs compile LegendaryMissions --run      # also try starting it (a quick smoke test)
sbs compile MyTerminalThing --terminal   # for command-line-only MAST projects
```

### `sbs lint` — check a mission's AMD files for broken links

Where `compile` checks the mission's *script*, `lint` checks its *content* — the
`.amd` files that hold quest logs, dialogue, cast, and maps. AMD's mistakes tend to
fail **silently**: a mistyped heading can make a whole quest vanish with no error, a
menu choice or "reveal" can point at nothing, a comms line can fire a signal no
script listens for, or a quest can send the player to an empty spot on the map.
`lint` finds all of that without launching the game.

```
sbs lint MyMission              # check the mission's .amd files
sbs lint MyMission --strict     # also fail on warnings (good for CI)
sbs lint MyMission --no-cross   # skip the signal-route and map-cell checks
```

Structural mistakes (a heading that won't parse, an unclosed `---` block, a skipped
heading level) are **errors** and fail the check. Dangling references are
**warnings**. The exit code is `0` when clean and `1` when there are errors (or any
warnings under `--strict`), so it drops straight into a build script.

For **CI or editors**, add `--format json` (structured findings) or `--format
compact` (`file:line:col:` lines for editor problem-matchers). And for **live
squiggles as you type**, `sbs lint --lsp` runs an AMD language server (LSP over
stdio) that any editor — VSCode, Neovim, Emacs — can connect to (it also does
go-to-definition, outline, hover, completion, and format-on-save). A ready-to-build
**VSCode extension** (syntax highlighting + a client for this server) lives in
[`editors/vscode/`](editors/vscode/).

### `sbs fmt` — tidy up a mission's AMD files

Canonically formats `.amd` files: trailing whitespace, heading spacing, `---`
fences, and blank-line runs. It's **prose-safe** — it never reflows your writing —
and idempotent, so it's safe to run any time (or on save via the language server).

```
sbs fmt MyMission              # format the .amd files in place
sbs fmt MyMission --check      # report + fail if anything isn't formatted (CI)
```

---

## For maintainers — publishing releases

These are for the people who publish the official libraries. Most users never
touch them.

### `sbs release` — tag a new release on GitHub

Adds (or removes) a version tag, which triggers GitHub to build and publish a
release. The version comes from the project's `__lib__.json` unless you override
it with `--version`. **Only works if you have publish rights to the repository.**

```
sbs release LegendaryMissions "My release notes"           # publish a release
sbs release LegendaryMissions -u "Notes"                    # un-publish (remove the tag)
sbs release LegendaryMissions --version v1.4.1 "Notes"      # publish a specific version
```

### Working on the `sbs` tool itself

The repository also has a `dev.pyz` helper for people developing the `sbs` tool:

```
dev.pyz install --dev    # install the pieces needed to work on the tool
dev.pyz build            # build sbs.pyz
dev.pyz build --install  # install, then build
dev.pyz release "Notes"  # publish a new release of the tool
dev.pyz version          # show the tool's version
```

---

## Recipes — "I want to…"

**"I always want the very latest missions."**
```
sbs fetch LegendaryMissions,SecretMeeting,WalkTheLine
```

**"I messed with a mission's script and just want the clean version back."**
```
sbs fetch LegendaryMissions --branch v1.3.0
```

**"I'm setting up a fresh Artemis Cosmos install."**
Update the tool first, then grab all the stock missions:
```
sbs update
sbs production -q
```

**"I want to play across a main screen and a helm station."**
```
sbs run mainscreen,helm
```

**"I'm writing a mission and want to see it without a full crew."**
```
sbs debug . --map 0
```
Then open http://localhost:8765/ in your browser.

**"I keep changing Legendary Missions and want my changes picked up automatically."**
Clone the mission from GitHub, then leave a watcher running:
```
sbs watch LegendaryMissions
```

**"…and I also edit the shared `sbs_utils` library."**
```
sbs watch LegendaryMissions,sbs_utils
```

**"…and I use my own fork (say, `western_back`) in the mission's story.json."**
```
sbs watch western_back:LegendaryMissions,western_back:sbs_utils
```

**"I want to burn-in test Cosmos by letting it play itself."**
Set up the mission's `settings.yaml` for autoplay and auto-start, then:
```
sbs run
```
Start the server and clients and let it run.

---

## Command cheat sheet

| Command | What it's for |
|---|---|
| `sbs fetch <name>` | Download one (or several) missions |
| `sbs production` | Download all the missions that ship with Cosmos |
| `sbs run <consoles>` | Launch the game — one window or many |
| `sbs debug <folder>` | Test-fly a mission in your browser |
| `sbs web <folder>` | Serve a mission's live web pages |
| `sbs web-static <folder> <page>` | Save a web page as a standalone HTML file |
| `sbs overnight <folder>` | Long, self-playing soak test |
| `sbs lib <folder>` | Package a mission's libraries/add-ons |
| `sbs watch <folder>` | Auto-rebuild libraries as you edit |
| `sbs compile <folder>` | Check a mission's script for errors |
| `sbs lint <folder>` | Check a mission's AMD (.amd) files for broken links |
| `sbs fmt <folder>` | Canonically format a mission's AMD (.amd) files |
| `sbs release <folder>` | Publish a release (maintainers only) |
| `sbs update` | Update the `sbs` tool itself |
| `sbs version` | Show the tool's version |

Type `sbs <command> --help` for the full details on any of these.

---

## Still cooking

A `-latest` version scheme is planned, so hot-fixes (like `v1.3.0-fix2`) can be
picked up automatically. It isn't wired up yet — older versions won't have a
`-latest` to point at.
