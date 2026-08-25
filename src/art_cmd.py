"""`sbs art` - validate, clear and rebuild the art the ENGINE bakes for itself.

A hull's `.paxmesh` and its `<root>1024.png` / `<root>256.png` are not authored. The engine
generates them the first time it draws that hull, beside the source `.obj`. They are never
packaged (see `file_help.is_derived_art`) - they are per-install output, rebuilt wherever
the art actually lives, so carrying them in a zip only ships one machine's copy of
something every machine makes for itself.

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
import json
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

# SPAWNING IS NOT DRAWING, and that is the whole difficulty of baking from a script. The
# engine bakes a hull's derived art when it RENDERS it - `MeshSilhouette` runs off the
# draw path - so a mission that spawns an object and waits bakes nothing at all. The first
# version of this did exactly that and would have reported `timeout` for every hull.
#
# So: an invisible detached camera for the server console to ride (the Game Master /
# Admiral pattern), a `3dview` widget so there IS a render, and the hull parked in front
# of it.
# SPAWNING IS NOT DRAWING, and that is the whole difficulty of baking from a script. The
# engine bakes a hull's derived art when it RENDERS it - `MeshSilhouette` runs off the
# draw path - so a mission that spawns objects and waits bakes nothing. The first version
# of this did exactly that and would have reported `timeout` for every hull.
#
# THE PARADE. One invisible detached camera at the origin (the Game Master / Admiral
# pattern) with a `3dview` so there IS a render, and every hull is MOVED in front of it in
# turn rather than the camera being aimed at each. Moving the subject to a known-good spot
# is far easier to get right than pointing a camera, and it means every hull is drawn at
# the same distance in the same frame position.
#
# The sim comes up PAUSED, so `sim_resume()` is load-bearing: without it the frame never
# advances, nothing renders, and a paused bake looks exactly like a hull that cannot bake.
_STORY_MAST = """
@map/bake "Bake"
    bake_cam = to_object(player_spawn(0, 0, 0, "BakeCam", "#,bake_cam", "invisible"))
    remove_role(bake_cam, "__player__")
    sbs.assign_client_to_ship(0, bake_cam.id)
    sim_resume()
{extras}
    bake_ids = []
    for bake_key in {keys!r}:
        bake_ids.append(npc_spawn(90000, 0, 90000, "Bake", "tsn", bake_key, "behav_station"))
    jump bake_watch

== bake_watch ==
    gui_console("bake_view")
    sub_task_schedule(bake_parade)
    await gui()

== bake_parade ==
    for bake_id in bake_ids:
        bake_obj = to_object(bake_id)
        continue if bake_obj is None
        bake_obj.pos = Vec3(0, 0, 1200)
        await delay_sim({dwell})
        bake_obj.pos = Vec3(90000, 0, 90000)
    ->END

@console/bake_view !0 ^1 "Bake"
    gui_layout_widget("3dview")
    await gui()

"""

def _shipdata_keys_by_artroot(cosmos):
    """artfileroot basename -> shipData key, so a folder name can be spawned.

    Reads the files as TEXT rather than parsing them: they are large, the two fields
    wanted are flat, and a parse failure would take out a command whose whole job is
    repairing a broken install.

    A MOD DECLARES ITS HULLS IN ITS OWN FILE, not in shipData.yaml - the media pack
    carries something like `tng_ships.json` and the addon points the engine at it with
    `ship_data_add_extra`. Without those a mod hull has no key here and `bake` reports
    "no shipData key" for art that bakes perfectly well.
    """
    import re
    sources = [os.path.join(cosmos, "data", "shipData.yaml")]
    media = os.path.join(cosmos, "data", "missions", "__lib__", "media")
    for root, _dirs, files in os.walk(media):
        for f in files:
            if f.lower().endswith((".json", ".yaml")) and "ship" in f.lower():
                sources.append(os.path.join(root, f))
    out = {}
    for path in sources:
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                txt = f.read()
        except OSError:
            continue
        pat = r'"key"\s*:\s*"([^"]+)"(.*?)(?="key"\s*:|\Z)'
        for key, body in re.findall(pat, txt, re.S):
            m = re.search(r'"artfileroot"\s*:\s*"([^"]*)"', body)
            if m and m.group(1):
                out.setdefault(os.path.basename(m.group(1)).lower(), key)
    return out


_SCRIPT_PY = '''import sbslibs
from sbs_utils.handlerhooks import *
from sbs_utils.gui import Gui
from sbs_utils.mast.maststorypage import StoryPage

class BakePage(StoryPage):
    story_file = "story.mast"

Gui.server_start_page_class(BakePage)
Gui.client_start_page_class(BakePage)
'''


def _newest_libs(names, ext):
    """The NEWEST version of each library in `__lib__`, by extension.

    `__lib__` holds every release side by side - `…ai.v1.1.0.mastlib` sits next to
    `v1.3.0`, `v1.4.0` and `v1.4.0_dev`, so 117 files are really about 30 addons. Loading
    the lot means every addon three times over at three different vintages, which is not
    a mission any engine should be asked to run.

    Version is compared NUMERICALLY, not as a string: `v1.10.0` sorts before `v1.4.0`
    lexically, and that bug would only appear on the release that finally reached ten.
    `_dev` builds are excluded - they are a working tree, not a release.
    """
    import re
    pat = re.compile(r"^(?P<id>.+)\.v(?P<ver>\d+(?:\.\d+)*)(?P<tag>_[A-Za-z]+)?\."
                     + re.escape(ext) + r"$")
    best = {}
    for n in names:
        m = pat.match(n)
        if not m or m.group("tag"):
            continue
        key = m.group("id")
        ver = tuple(int(x) for x in m.group("ver").split("."))
        if key not in best or ver > best[key][0]:
            best[key] = (ver, n)
    return sorted(v[1] for v in best.values())


def _extra_ship_data_calls(cosmos):
    """`ship_data_add_extra` lines for every mod ship-data file on disk.

    WHY NOT JUST LOAD THE MOD'S ADDON. The first version listed every mastlib in the
    generated story.json so that a mod's `ship_data_add_extra` would run and its hulls
    would exist. That pulls in ~42 addons - all of LegendaryMissions' gameplay - to get
    one registration call, and `__lib__` keeps every past release side by side, so the
    first cut loaded v1.1.0, v1.3.0 and v1.4.0 of everything at once.

    The mission can just make the call itself. `ship_data_add_extra` takes the stem and
    an explicit path, so nothing but sbs_utils needs to load - no gameplay, no side
    effects, no version soup.
    """
    out = []
    media = os.path.join(cosmos, "data", "missions", "__lib__", "media")
    for root, _dirs, files in os.walk(media):
        for f in sorted(files):
            if not f.lower().endswith((".json", ".yaml")) or "ship" not in f.lower():
                continue
            stem = os.path.splitext(f)[0]
            rel = os.path.relpath(root, cosmos).replace(os.sep, "/")
            out.append(f'    ship_data_add_extra("{stem}", path="{rel}")')
    return chr(10).join(out)


def _write_bake_mission(cosmos, missions, keys, dwell):
    """A throwaway mission that parades `keys` past a camera.

    Deliberately NOT VisualTestRange's `visual_art_census` map, which does this job well
    but lives in Cosmos-dev and is absent from a normal install.
    """
    folder = os.path.join(missions, "_sbs_art_bake")
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder)
    lib = os.path.join(missions, "__lib__")
    names = os.listdir(lib)
    sbslib = [f for f in _newest_libs(names, "sbslib")
              if f.startswith("artemis-sbs.sbs_utils.")]
    # ONLY sbs_utils. The mod ship-data files are registered by the mission itself, so
    # no addon has to load - see _extra_ship_data_calls.
    story = {"sbslib": sbslib}
    with open(os.path.join(folder, "story.json"), "w", encoding="utf-8") as f:
        json.dump(story, f, indent=4)
    with open(os.path.join(folder, "story.mast"), "w", encoding="utf-8") as f:
        f.write(_STORY_MAST.format(keys=list(keys), dwell=dwell,
                                     extras=_extra_ship_data_calls(cosmos)))
    with open(os.path.join(folder, "script.py"), "w", encoding="utf-8") as f:
        f.write(_SCRIPT_PY)
    return folder


def _bake_batch(cosmos, missions, targets, settle, dwell):
    """Bake a whole batch in ONE engine run. Returns {root: "baked"|"crashed"|"timeout"}.

    BATCHED, not one run per hull. The original did one engine start each, to stop a crash
    costing the batch - but the crash that motivated it turned out to be a STALE half-baked
    mesh, and a clean bake works. So paying an engine start per hull bought very little and
    cost minutes. What actually protects the run is that progress is durable: every hull
    that finished has its files on disk, so a crash mid-parade loses only the remainder, and
    the caller retries those.
    """
    keys = [k for _d, _r, k in targets]
    _write_bake_mission(cosmos, missions, keys, dwell)
    exe = os.path.join(cosmos, EXE)
    if not os.path.isfile(exe):
        raise click.ClickException(f"engine not found: {exe}")
    # ABSOLUTE PATH, not a bare name: CreateProcess only searches the working directory
    # when `NoDefaultCurrentDirectoryInExePath` is unset, and MSYS2/Git-Bash exports it.
    proc = subprocess.Popen([exe, "autostartserver", "defaultmission=_sbs_art_bake"],
                            cwd=cosmos)
    done = {}
    try:
        import time
        deadline = time.time() + settle + dwell * len(targets)
        while time.time() < deadline:
            for d, root, _k in targets:
                if root in done:
                    continue
                if derived_art_status(d).get(root, {}).get("state") == "complete":
                    done[root] = "baked"
            if len(done) == len(targets):
                break
            if proc.poll() is not None:
                break                       # died - whatever finished still counts
            time.sleep(1.0)
        crashed = proc.poll() is not None
        for _d, root, _k in targets:
            done.setdefault(root, "crashed" if crashed else "timeout")
        return done
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
@click.option("--dwell", default=3.0, show_default=True, metavar="SECONDS",
              help="Sim-seconds each hull is held in front of the camera.")
@click.option("--dry-run", is_flag=True, help="Show what would be baked, launch nothing.")
def art_bake(folder, undrawn, settle, dwell, dry_run):
    """Clear half-baked art and drive the engine to bake it again.

    BATCHED: every hull is paraded past one camera in a SINGLE engine run. It used to be
    one run per hull, to stop a crash costing the batch - but the crash that motivated
    that turned out to be a stale half-baked mesh, and a clean bake works. Progress is
    durable anyway: each hull that finishes has its files on disk, so a crash mid-parade
    loses only the remainder, and those are retried one at a time to find the bad one.

    MOD ART BAKES WHERE IT LIVES, like everything else. This used to refuse to touch it,
    on the strength of a 1.3.5 writeup saying a `.paxmesh` stores its texture paths under
    `data/graphics/` so a mesh baked elsewhere cannot find them - and telling people to
    bake in `data/graphics` and copy back. That is superseded: `artfileroot` is the whole
    path as of 1.3.6, `artfilepath` is gone, and the Cosmos-TNG-Mod media pack has all 46
    of its hulls baked in place, complete with sprites. The refusal blocked art that bakes
    perfectly well.

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
    baked, failed, skipped, todo = [], [], [], []
    for _label, d, root, _info in rows:
        key = keys.get(root.lower())
        if not key:
            skipped.append((root, "no shipData key points at this art root"))
            continue
        if dry_run:
            baked.append(root)
            print(f"  would bake {root} (key {key})")
            continue
        todo.append((d, root, key))

    if todo:
        # Clear the partial files first: a stale mesh without its sprites is the state
        # that crashes the bake, so going in clean is the point of the exercise.
        for d, root, _key in todo:
            for f in derived_art_files(d, root):
                os.remove(os.path.join(d, f))
        print(f"  baking {len(todo)} hull(s) in one run ...", flush=True)
        done = _bake_batch(cosmos, missions, todo, settle, dwell)
        left = [t for t in todo if done.get(t[1]) != "baked"]
        baked += [t[1] for t in todo if done.get(t[1]) == "baked"]
        # RETRY THE REMAINDER ONE AT A TIME. A batch that died says nothing about WHICH
        # hull killed it; alone, each one either bakes or names itself.
        if left:
            print(f"  {len(left)} did not finish - retrying individually", flush=True)
        for d, root, key in left:
            for f in derived_art_files(d, root):
                os.remove(os.path.join(d, f))
            print(f"    {root} ...", end="", flush=True)
            one = _bake_batch(cosmos, missions, [(d, root, key)], settle, dwell)
            state = one.get(root, "timeout")
            print(f" {state}")
            if state == "baked":
                baked.append(root)
            else:
                failed.append((root, state))
                for f in derived_art_files(d, root):   # never leave the crashing state
                    os.remove(os.path.join(d, f))

    verb = "would bake" if dry_run else "baked"
    tail = "" if dry_run else f", failed {len(failed)}"
    print()
    print(f"  {verb} {len(baked)}{tail}, skipped {len(skipped)}")
    for root, why in failed:
        print(f"  !!  {root}: {why} - this hull cannot be baked on this build")
    for root, why in skipped:
        print(f"  --  {root}: {why}")
