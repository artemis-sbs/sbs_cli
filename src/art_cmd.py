"""`sbs art` - validate, clear and rebuild the art the ENGINE bakes for itself.

A hull's `.paxmesh` and its `<root>1024.png` / `<root>256.png` are not authored. The engine
generates them the first time it draws that hull, beside the source `.obj`. They are never
packaged (see `file_help.is_derived_art`) because a baked mesh hardcodes its texture paths
under `data/graphics/`, so shipping one points another install at somebody else's disk.

WHY THIS COMMAND EXISTS. If the engine dies partway through a bake it leaves the mesh
without its sprites - and every later draw retries, dies at the same point, and leaves the
same wreckage. That is a client crash-to-desktop on every draw of that hull, permanently.
Three hulls were in that state in one install and cost two separate crash investigations
before anyone looked at the folder; the fix was deleting the stale `.paxmesh` and letting
the engine bake clean.

WHAT THIS CANNOT DO, and it shapes the whole design: nothing here bakes anything. Only the
engine can. `bake` clears what is broken and then DRIVES the engine, one hull per run, and
reads the exit code - because the thing being repaired is the engine crashing mid-bake, so
a batch that dies takes the whole batch with it.
"""
import os
import shutil
import subprocess
import tempfile

import click

from cli_cmd import cli, zipapp_dir
from file_help import derived_art_status, derived_art_files

EXE = "Artemis3-x64-release.exe"


def _cosmos_root():
    """(install root, missions folder), from this tool's own location.

    WALK UP TO THE FOLDER NAMED `missions` rather than counting levels. Deployed, this file
    lives in `…/data/missions/sbs.pyz/art_cmd.py`, one level down. In a source checkout it is
    `…/data/missions/sbs_cli/src/art_cmd.py`, two. `run_cmd` gets away with a single
    `dirname` because it only ever runs from the zipapp; anything that also runs from source
    has to search.
    """
    here = os.path.dirname(os.path.realpath(__file__))
    missions = here
    while os.path.basename(missions).lower() != "missions":
        parent = os.path.dirname(missions)
        if parent == missions:                      # hit the drive root - give up cleanly
            return os.path.dirname(os.path.dirname(here)), here
        missions = parent
    return os.path.dirname(os.path.dirname(missions)), missions


def _art_dirs(base):
    """Folders under `base` holding source meshes."""
    out = []
    for root, _subdirs, files in os.walk(base):
        if "__pycache__" in root:
            continue
        if any(f.lower().endswith(".obj") for f in files):
            out.append(root)
    return out


def _targets(folder):
    """(label, absolute path) for every art tree in scope.

    The install's own `data/graphics` AND mission / `__lib__/media` art, because a
    half-baked mesh crashes the client wherever it came from. A `.paxmesh` inside a media
    pack is a finding in its own right - it should never have been packaged.
    """
    cosmos, missions = _cosmos_root()
    out = []
    if folder:
        cand = os.path.join(missions, folder)
        base = cand if os.path.isdir(cand) else folder
        return [(os.path.basename(os.path.abspath(base)), os.path.abspath(base))]
    graphics = os.path.join(cosmos, "data", "graphics")
    if os.path.isdir(graphics):
        out.append(("data/graphics", graphics))
    for d in sorted(os.listdir(missions)):
        p = os.path.join(missions, d)
        if os.path.isdir(p) and d != "__lib__":
            out.append((d, p))
    lib_media = os.path.join(missions, "__lib__", "media")
    if os.path.isdir(lib_media):
        out.append(("__lib__/media", lib_media))
    return out


def _scan(folder):
    """[(label, dir, root, info)] for every art root in scope."""
    rows = []
    for label, base in _targets(folder):
        for d in _art_dirs(base):
            for root, info in derived_art_status(d).items():
                rows.append((label, d, root, info))
    return rows


def _report(rows):
    half = [r for r in rows if r[3]["state"] == "half"]
    complete = sum(1 for r in rows if r[3]["state"] == "complete")
    unbaked = sum(1 for r in rows if r[3]["state"] == "unbaked")
    print(f"  {complete} baked, {unbaked} not yet drawn, {len(half)} half-baked")
    for label, d, root, info in half:
        print(f"  !!  {label}: {root} - missing {', '.join(info['absent'])}")
    return half


@cli.group()
def art():
    """Validate, clear and rebuild engine-baked art."""


@art.command("check")
@click.argument("folder", default=None, required=False)
@click.option("--strict", is_flag=True, help="Exit 1 if anything is half-baked.")
def art_check(folder, strict):
    """Report art the engine baked only partway.

    A half-baked root is the crashing state. A root with nothing derived is simply art
    nobody has drawn yet and is NOT a problem - saying so would flag every mesh in a fresh
    install.
    """
    half = _report(_scan(folder))
    if half and strict:
        raise SystemExit(1)


@art.command("clear")
@click.argument("folder", default=None, required=False)
@click.option("--all", "clear_all", is_flag=True,
              help="Clear every baked root, not only the broken ones. Slow to rebuild.")
@click.option("--dry-run", is_flag=True, help="List what would be deleted.")
def art_clear(folder, clear_all, dry_run):
    """Delete engine-baked files so the engine bakes them again.

    Only the half-baked roots by default: those are the ones that crash, and clearing a
    healthy root just buys a slow rebake. `--all` is the sledgehammer.
    """
    rows = _scan(folder)
    want = [r for r in rows
            if r[3]["state"] == "half" or (clear_all and r[3]["state"] == "complete")]
    if not want:
        print("  nothing to clear")
        return
    n = 0
    for _label, d, root, _info in want:
        for f in derived_art_files(d, root):
            path = os.path.join(d, f)
            print(f"  {'would delete' if dry_run else 'deleted'}  {path}")
            if not dry_run:
                os.remove(path)
            n += 1
    print(f"  {n} file(s){' (dry run)' if dry_run else ''}")
    if not dry_run:
        print("  the engine bakes these again the next time it draws each hull "
              "(`sbs art bake` drives it)")


# --- bake -----------------------------------------------------------------------------
#
# NOTHING HERE BAKES ANYTHING. Only the engine does, on first draw. This clears what is
# broken and then drives the engine at it, which is the only lever available.

_STORY_MAST = '''@map/bake "Bake"
    npc_spawn(0, 0, 3000, "Bake", "tsn", "{key}", "behav_station")
    await delay_sim(600)
    ->END
'''

_SCRIPT_PY = '''import sbslibs
from sbs_utils.handlerhooks import *
from sbs_utils.gui import Gui
from sbs_utils.mast.maststorypage import StoryPage

class BakePage(StoryPage):
    story_file = "story.mast"

Gui.server_start_page_class(BakePage)
Gui.client_start_page_class(BakePage)
'''


def _shipdata_keys_by_artroot(cosmos):
    """artfileroot basename -> shipData key, so a folder name can be spawned.

    Reads shipData.yaml as TEXT rather than parsing it as YAML: the file is large, the two
    fields wanted are flat, and a parse failure here would take out a command whose whole
    job is repairing a broken install.
    """
    import re
    path = os.path.join(cosmos, "data", "shipData.yaml")
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            txt = f.read()
    except OSError:
        return {}
    out = {}
    for key, body in re.findall(r'"key"\s*:\s*"([^"]+)"(.*?)(?="key"\s*:|\Z)', txt, re.S):
        m = re.search(r'"artfileroot"\s*:\s*"([^"]*)"', body)
        if m and m.group(1):
            out.setdefault(os.path.basename(m.group(1)).lower(), key)
    return out


def _write_bake_mission(missions, key):
    """A throwaway mission that spawns exactly one hull.

    Deliberately NOT VisualTestRange's `visual_art_census` map, which does this job well but
    lives in Cosmos-dev and is absent from a normal install. Generating it keeps `bake`
    self-contained, and one hull per mission is what makes a crash cost one hull.
    """
    folder = os.path.join(missions, "_sbs_art_bake")
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder)
    lib = os.path.join(missions, "__lib__")
    sbslib = sorted(f for f in os.listdir(lib)
                    if f.startswith("artemis-sbs.sbs_utils.") and f.endswith(".sbslib")
                    and "_dev" not in f)
    with open(os.path.join(folder, "story.json"), "w", encoding="utf-8") as f:
        f.write('{\n    "sbslib": ["%s"]\n}\n' % (sbslib[-1] if sbslib else ""))
    with open(os.path.join(folder, "story.mast"), "w", encoding="utf-8") as f:
        f.write(_STORY_MAST.format(key=key))
    with open(os.path.join(folder, "script.py"), "w", encoding="utf-8") as f:
        f.write(_SCRIPT_PY)
    return folder


def _bake_one(cosmos, missions, folder, root, key, settle):
    """Draw one hull in a real engine until its derived files appear.

    Returns "baked" | "crashed" | "timeout". The EXIT CODE is what says the engine died -
    inferring death from the files not appearing cannot tell a crash from a slow bake, and
    this command exists because the engine crashes here.
    """
    _write_bake_mission(missions, key)
    exe = os.path.join(cosmos, EXE)
    if not os.path.isfile(exe):
        raise click.ClickException(f"engine not found: {exe}")
    # ABSOLUTE PATH, not a bare name: CreateProcess only searches the working directory when
    # `NoDefaultCurrentDirectoryInExePath` is unset, and MSYS2/Git-Bash exports it.
    proc = subprocess.Popen([exe, "autostartserver", "defaultmission=_sbs_art_bake"],
                            cwd=cosmos)
    try:
        import time
        deadline = time.time() + settle
        while time.time() < deadline:
            if proc.poll() is not None:
                return "crashed"
            if derived_art_status(folder).get(root, {}).get("state") == "complete":
                return "baked"
            time.sleep(1.0)
        return "timeout"
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(os.path.join(missions, "_sbs_art_bake"), ignore_errors=True)


@art.command("bake")
@click.argument("folder", default=None, required=False)
@click.option("--undrawn", is_flag=True,
              help="Also bake art that has never been drawn, not just the broken ones.")
@click.option("--settle", default=90.0, show_default=True, metavar="SECONDS",
              help="How long to give one hull before calling it a timeout.")
@click.option("--dry-run", is_flag=True, help="Show what would be baked, launch nothing.")
def art_bake(folder, undrawn, settle, dry_run):
    """Clear half-baked art and drive the engine to bake it again.

    ONE HULL PER ENGINE RUN. The failure being repaired is the engine dying mid-bake, so a
    batch that dies takes the batch with it; this way a crash costs one hull and the run
    continues. A hull that crashes has its partial output deleted before moving on, so the
    install is never left in the state that crashes every client that draws it.

    Only the install's own `data/graphics` can be baked in place. A mod's art cannot: a
    `.paxmesh` stores its texture paths under `data/graphics/`, so a mesh baked anywhere
    else looks for textures that are not there. Those are reported, not baked.

    --undrawn ALSO BAKES ART NOBODY HAS DRAWN YET, which is how you make sure a crash
    cannot happen live: every bake that has already happened is a bake that cannot fail
    during a game. Expect it to reach fewer roots than the count suggests - most undrawn
    art has no shipData key pointing at it (superseded hulls, mesh sub-parts like
    `monster2_jaw`, and non-ship assets like `skyPlane`), and nothing can spawn what
    nothing names. Those are listed as skipped rather than silently passed over, because
    "17 undrawn" reading as "17 to bake" is exactly the wrong impression.
    """
    cosmos, missions = _cosmos_root()
    wanted = ("half", "unbaked") if undrawn else ("half",)
    rows = [r for r in _scan(folder) if r[3]["state"] in wanted]
    if not rows:
        print("  nothing to do" if undrawn else "  nothing half-baked - nothing to do")
        return
    keys = _shipdata_keys_by_artroot(cosmos)
    graphics = os.path.join(cosmos, "data", "graphics")
    baked, failed, skipped = [], [], []
    for label, d, root, _info in rows:
        key = keys.get(root.lower())
        if not os.path.abspath(d).startswith(os.path.abspath(graphics)):
            skipped.append((root, "mod art - bake it in data/graphics and copy back"))
            continue
        if not key:
            skipped.append((root, "no shipData key points at this art root"))
            continue
        if dry_run:
            baked.append(root)
            print(f"  would bake {root} (key {key})")
            continue
        for f in derived_art_files(d, root):      # clear IMMEDIATELY before its own run
            os.remove(os.path.join(d, f))
        print(f"  baking {root} (key {key}) ...", flush=True)
        result = _bake_one(cosmos, missions, d, root, key, settle)
        if result == "baked":
            baked.append(root)
        else:
            failed.append((root, result))
            for f in derived_art_files(d, root):  # never leave the crashing state behind
                os.remove(os.path.join(d, f))
        print(f"    {result}")
    # The skip list is the POINT of a dry run here: "20 undrawn" reads as "20 to bake",
    # and 16 of them have no shipData key, so nothing can spawn them. Returning early hid
    # exactly the number the flag exists to set expectations about.
    verb = "would bake" if dry_run else "baked"
    tail = "" if dry_run else f", failed {len(failed)}"
    print()
    print(f"  {verb} {len(baked)}{tail}, skipped {len(skipped)}")
    for root, why in failed:
        print(f"  !!  {root}: {why} - this hull cannot be baked on this build")
    for root, why in skipped:
        print(f"  --  {root}: {why}")
