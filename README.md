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

### `sbs swap` — switch between mission sets

Cosmos loads exactly one `data/missions` folder. If you keep several sets side by
side — say `missions_amd` and `missions_mast` from a converter, plus the stock
missions — `sbs swap` repoints `data/missions` at whichever one you want. Nothing
is copied; it just moves a link.

```
sbs swap                # which set is active, and what else is available
sbs swap amd            # load data/missions_amd
sbs swap mast           # load data/missions_mast
```

Any folder named `missions_<name>` next to `data/missions` is a valid target, so
adding a set is just creating the folder. The prefix is optional — `amd` and
`missions_amd` mean the same thing.

If your `data/missions` is a **real folder** (a normal install), the first swap
renames it to `missions_cos` instead of deleting it, so `sbs swap cos` puts you
back on the stock missions. It never deletes a mission folder — only the link.

> **Heads up:** close Cosmos first. A running client holds files open under the
> link, and the swap will refuse rather than half-finish.

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
sbs run                         # six windows (server + comms/weapons/science/
                                # engineering/cinematic) — a full test bridge
sbs run helm,comms              # two windows: one Helm, one Comms
sbs run server,helm,comms       # a server plus two consoles
sbs run --dry-run               # show the command lines, launch nothing
```

Just list the consoles you want, separated by commas.

**Nothing needs clicking.** The server starts itself and each client connects on its
own — you land on the console you asked for.

**Which mission?** `LegendaryMissions` unless you say otherwise:

```
sbs run -m LM_TestRange         # a different mission
sbs run -m SecretMeeting helm   # one console, one mission
```

Your `preferences.json` is left alone — the mission is named on the launch, not stored in
a shared file that the next run has to undo.

**Playing across machines?** Point the clients at the server:

```
sbs run comms,weapons --ip 192.168.1.50
```

### Passing things through to the mission

Anything you add on the end is handed to every window as-is, so a mission can read
launch arguments the CLI has never heard of:

```
sbs run -m LM_TestRange map=sandbox profile=soak var.DIFFICULTY=3
sbs run -m LegendaryMissions record=session      # transcribe what you click
sbs run -m LegendaryMissions test=60             # write a pass/fail verdict
```

`map=`, `profile=`, `var.NAME=`, `seed=`, `run=`, `record=` and `test=` are described
under [command-line arguments](https://artemis-sbs.github.io/sbs_utils/tooling/command-line/).

### If something looks wrong

`--dry-run` prints exactly what each window would be launched with and starts nothing —
the quickest way to see whether an argument is reaching the game.

`--no-auto` goes back to the old behavior, where every window opens at the launcher menu
and waits for you.

Naming consoles without a `server` means nothing is serving, and `sbs run` says so rather
than leaving you with clients that cannot connect.

---

## Starting a new mission

### `sbs create` — start from a boilerplate

Makes a new mission folder from a template, and downloads the libraries it needs.
Run it from your `missions` folder.

```
sbs create MyMission                 # pick a template from a list
sbs create MyMission -t sandbox      # pick it up front
sbs create MyMission --title "My Mission"
```

The templates live in the
[mast_starter](https://github.com/artemis-sbs/mast_starter) repository, so new
ones appear without you updating the tool.

**About versions.** Missions are pinned to a *release line* — v1.3.0, v1.4.0 —
and everything a mission depends on comes from the same line. `sbs create` picks
the newest line your install already has libraries for, and never picks one newer
than your copy of Cosmos: a mission your game can't launch is not a useful
starting point. It tells you which line it chose and why, and you can override:

```
sbs create MyMission -l v1.4.0       # pin to a line
sbs create MyMission -b v1.4.0_dev   # use a specific starter branch
```

Not every template exists on every line — a template can only use language
features its line actually has.

`sbs create` will not write into a folder that already has anything in it.

### `sbs templates` — see what you can start from

```
sbs templates
```

Lists every template on every release line, and marks the line `sbs create` would
choose for you.

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

It stops with an error code when the script doesn't compile, so you can use it in a
script or a build that should fail on a broken mission.

> **What it can't see.** A `{ }` list broken across several lines. MAST reads one
> line at a time, so the first line is an unfinished `{` — the rest of the file
> quietly stops making sense, and `compile` still says everything is fine. The
> mission then runs and does *nothing*. Keep those on one line, or wrap them in
> `~~ ... ~~`. If a mission mysteriously does nothing at all, suspect this first.

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

### `sbs docs` — turn a mission into something you can read on paper

Your `.amd` files hold the quests, the dialogue, the cast, the lore. Up to now the
only thing that could read them was the game, so reviewing a script or looking up
a faction key meant opening a code editor. `sbs docs` turns them into a document.

```
sbs docs .                      # a printable HTML page, into ./__docs__/
sbs docs . --pdf                # ...and a PDF beside it
sbs docs . --lens all --pdf     # all four editions, plus one bound book
sbs docs . --open               # build it and open it
```

**Four editions, because an .amd file is four different documents depending on who
is reading it.** Pick with `--lens`:

| Lens | What you get |
|---|---|
| `prose` | A manual or a story book — help text, lore, the codex |
| `catalog` | A sourcebook — sides, items, scans and landmarks as reference cards |
| `screenplay` | A script you could read aloud, laid out like a screenplay |
| `bible` | A design document — the quest spine, its triggers, and a map of the branches |

**Who is it for?** `--profile player` leaves out everything a player should never
see: author notes, the conditions on a dialogue choice, what a choice secretly
costs. It genuinely leaves them out of the file, so you can hand the PDF to
someone. (The `bible` lens has no player profile and will say so — the bible *is*
the spoiler.)

```
sbs docs . --lens prose --profile player --pdf
```

**Getting a PDF** needs no extra install: `--pdf` drives a headless Chrome or Edge,
which every Windows machine already has. If you also install the `weasyprint`
command it will use that instead where it is the better choice — it numbers the
contents list properly — except on documents with character faces, which it cannot
draw.

For a proper **bookmark sidebar** in the PDF, and to bind `--lens all` into one
book, add `pypdf`:

```
sbs deps install pypdf
```

Without it you still get the PDFs, just no bookmarks — `sbs docs` mentions it once
and carries on.

---

## When something isn't right

### `sbs doctor` — check your setup

Tells you what's installed, what a mission expects, and what's missing. It looks at
your *setup*, never at your writing — for that, use `sbs lint` and `sbs compile`.

```
sbs doctor                 # everything it can see
sbs doctor MyMission       # your setup, plus one mission
sbs doctor --env           # just the tools and folders
```

Three markers: `ok` is fine, `--` means something optional isn't installed (not a
problem), and `!!` is a real problem — always followed by the command that fixes
it.

It finishes with a count, so you don't have to read every line to see whether
anything needs doing:

```
17 checks: 14 ok, 3 optional absent, 0 problems
```

If there are problems it also tells you which parts of the report to look in — the
fix for each one is already printed next to it.

It always exits successfully, because it's a report and not a test. Use `--strict`
if you want it to fail a build, or `--json` to feed it to something else.

It also checks your **ship art** — see `sbs art` below for what that means and how
to fix it.

### `sbs deps` — optional extras

A few features can do more if an extra Python library is present. `sbs deps`
installs those.

```
sbs deps install pypdf     # PDF bookmarks and bound books for `sbs docs`
sbs deps list              # what's installed, and where
sbs deps remove pypdf
```

**Why you need this instead of plain `pip install`.** `sbs` runs on the small copy
of Python that ships inside Cosmos, and that copy is deliberately sealed off — it
ignores `PYTHONPATH` and can't see anything you install normally. `pip` doesn't
even appear to exist to it. So `pip install` cannot reach `sbs`, however correctly
you run it. `sbs deps` knows the way in.

Everything here is optional. Nothing you install is needed to run `sbs`, and every
feature that uses one works without it.

> **Heads up:** `sbs deps install weasyprint` will refuse. WeasyPrint needs
> graphics libraries that `pip` can't deliver on Windows — it would install
> perfectly and then fail the moment anything used it. Install the WeasyPrint
> Windows package instead.

**For missions, not just the tool.** Adding `--engine` installs somewhere a
*running mission* can use it. It asks first, because a mission that relies on it
will only run on machines where you've done the same — it's no longer something
you can just hand to someone.

### `sbs art` — check and repair the art the game builds for itself

Some of a ship's art isn't drawn by an artist — the game builds it the first time
it shows that ship, and saves it next to the original. If the game is interrupted
while it's doing that, it leaves the job half-finished.

**That is worth catching, because a half-finished ship crashes the game every time
anyone looks at it.** The game tries the job again, fails in the same place, and
leaves the same mess — so it never recovers on its own. Three ships were stuck like
that in one install and it took two separate crash hunts to find them.

```
sbs art check              # anything half-finished?
sbs art clear              # throw the half-finished bits away
sbs art bake               # ...and get the game to build them again
```

`check` is safe and reads nothing but file names. A ship listed as *not yet drawn*
is completely normal — that's just art nobody has looked at yet, and it is **not**
a problem.

`clear` deletes only the files the game made. Your `.obj` and your textures are
never touched. `bake` then starts the game once per ship to rebuild them, and tells
you at the end if any ship still won't build — which turns "the server keeps dying"
into a short list of names.

> Art that a **mod** carries can't be rebuilt where it sits, and `sbs art` says so
> rather than trying. The rebuilt file remembers where its textures were, so it has
> to be built in the game's own `data/graphics/ships` and copied back.

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

**"I want to write my first mission and I don't know where to start."**
```
sbs templates              # see what's on offer
sbs create MyMission       # pick one; it fetches the libraries too
sbs debug MyMission --map 0
```

**"I want to build something other people's missions can use."**
The `addon` template is a shareable add-on plus a little map to test it with:
```
sbs create MyAddon -t addon
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

**"I want to read my mission's story without playing it."**
```
sbs docs . --lens screenplay --pdf
```
The dialogue, laid out like a script. `--lens bible` instead gives you the quest
structure and what triggers what.

**"I want to hand someone the lore without spoiling the mission."**
```
sbs docs . --lens prose --profile player --pdf
```

**"Something isn't working and I don't know what."**
```
sbs doctor
```
Anything marked `!!` comes with the command that fixes it.

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
| `sbs create <name>` | Start a new mission from a boilerplate |
| `sbs templates` | List the boilerplates you can start from |
| `sbs fetch <name>` | Download one (or several) missions |
| `sbs production` | Download all the missions that ship with Cosmos |
| `sbs swap <name>` | Switch which `missions_*` set Cosmos loads |
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
| `sbs docs <folder>` | Turn a mission's AMD into a readable document (and a PDF) |
| `sbs doctor` | Check your setup — tools, libraries, missing pieces |
| `sbs deps install <pkg>` | Add an optional Python library `sbs` can use |
| `sbs release <folder>` | Publish a release (maintainers only) |
| `sbs update` | Update the `sbs` tool itself |
| `sbs version` | Show the tool's version |

Type `sbs <command> --help` for the full details on any of these.

---

## Still cooking

A `-latest` version scheme is planned, so hot-fixes (like `v1.3.0-fix2`) can be
picked up automatically. It isn't wired up yet — older versions won't have a
`-latest` to point at.
