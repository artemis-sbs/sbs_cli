from cli_cmd import cli
import click
import os
import sys
import json
import glob
import re


def _missions_dir():
    """The missions folder, in both dev (sbs_cli/) and deployed (missions/) modes."""
    here = os.path.dirname(os.path.realpath(__file__))
    if os.path.basename(here) != "missions":
        here = os.path.dirname(here)
    return here


def _find_sbs_utils():
    """Path to the sbs_utils source folder, or None if it isn't present."""
    candidate = os.path.join(_missions_dir(), "sbs_utils")
    return candidate if os.path.isdir(candidate) else None


def _sbs_utils_sbslib_from_story(mission_path):
    """The sbs_utils sbslib filename listed in the mission's story.json, or None.

    Picks the sbs_utils entry (excludes the cosmos_dev one) so we know which
    version to load.
    """
    story = os.path.join(mission_path, "story.json")
    if not os.path.isfile(story):
        return None
    try:
        with open(story) as f:
            data = json.load(f)
    except Exception:
        return None
    for name in data.get("sbslib", []):
        if ".sbs_utils." in name and ".cosmos_dev." not in name:
            return name
    return None


def _runner_lib_paths(mission_path):
    """Paths that make ``cosmos_dev.*`` importable: the sbs_utils source folder
    if present, else the packaged sbslibs in ``__lib__`` (the sbs_utils sbslib +
    the matching cosmos_dev sbslib). Used for sys.path (debug, in-process) and
    PYTHONPATH (overnight, which spawns child processes).
    """
    src = _find_sbs_utils()
    if src is not None:
        return [src]

    lib_dir = os.path.join(_missions_dir(), "__lib__")
    sbs_name = _sbs_utils_sbslib_from_story(mission_path)
    if sbs_name is None:
        # No story hint: take the newest sbs_utils sbslib present.
        cands = [c for c in sorted(glob.glob(
                    os.path.join(lib_dir, "artemis-sbs.sbs_utils.v*.sbslib")))
                 if ".cosmos_dev." not in os.path.basename(c)]
        if not cands:
            raise RuntimeError(
                "No sbs_utils source and no sbs_utils sbslib in __lib__.\n"
                "Fetch the dev libraries first:  sbs fetch sbs_utils")
        sbs_name = os.path.basename(cands[-1])

    sbs_path = os.path.join(lib_dir, sbs_name)
    cosmos_path = _find_cosmos_dev_sbslib(lib_dir, sbs_name)
    missing = []
    if not os.path.isfile(sbs_path):
        missing.append(sbs_name)
    if cosmos_path is None:
        missing.append("artemis-sbs.cosmos_dev.<version>.sbslib")
    if missing:
        raise RuntimeError(
            "Missing dev libraries (no sbs_utils source):\n  "
            + "\n  ".join(missing)
            + "\nGet them from the GitHub release, e.g.:\n"
            "  gh release download <version> -R artemis-sbs/sbs_utils -D __lib__")
    return [sbs_path, cosmos_path]


def _prepare_runner_path(mission_path):
    """Put the runner libs on this process's sys.path (in-process use)."""
    for p in _runner_lib_paths(mission_path):
        if p not in sys.path:
            sys.path.insert(0, p)


def _find_cosmos_dev_sbslib(lib_dir, sbs_name):
    """Locate the cosmos_dev sbslib (carries mission_runner/mockgui) for the same
    version as ``sbs_name``. Handles both naming conventions: the GitHub release
    asset (``artemis-sbs.cosmos_dev.<ver>.sbslib``) and the local sbs.pyz build
    (``artemis-sbs.sbs_utils.cosmos_dev.<ver>.sbslib``).
    """
    try:
        ver = sbs_name.split(".sbs_utils.", 1)[1].rsplit(".sbslib", 1)[0]
    except Exception:
        ver = None
    if ver:
        for name in (f"artemis-sbs.cosmos_dev.{ver}.sbslib",
                     f"artemis-sbs.sbs_utils.cosmos_dev.{ver}.sbslib"):
            p = os.path.join(lib_dir, name)
            if os.path.isfile(p):
                return p
    pattern = f"*cosmos_dev*{ver}*.sbslib" if ver else "*cosmos_dev*.sbslib"
    hits = sorted(glob.glob(os.path.join(lib_dir, pattern)))
    return hits[-1] if hits else None


def _parse_asset(asset):
    """Map a lib asset filename to (user, repo, tag) for its GitHub release.

    \b
    artemis-sbs.sbs_utils.v1.4.0.sbslib                 -> (artemis-sbs, sbs_utils, v1.4.0)
    artemis-sbs.cosmos_dev.v1.4.0.sbslib                -> (artemis-sbs, sbs_utils, v1.4.0)  # on sbs_utils' release
    artemis-sbs.LegendaryMissions.hangar.v1.4.0.mastlib -> (artemis-sbs, LegendaryMissions, v1.4.0)
    artemis-sbs.LegendaryMissions.media.v1.4.0.zip      -> (artemis-sbs, LegendaryMissions, v1.4.0)
    """
    m = re.search(r"\.(v[\w.]+?)\.(sbslib|mastlib|zip)$", asset)
    if not m:
        return None
    tag, ext = m.group(1), m.group(2)
    head = asset[:m.start()].split(".")
    if len(head) < 2:
        return None
    user = head[0]
    if ext == "sbslib":
        pkg = head[-1]                       # package name (sbs_utils / cosmos_dev)
        repo = "sbs_utils" if pkg in ("sbs_utils", "cosmos_dev") else pkg
    else:
        repo = head[1]                       # repo-namespaced (e.g. LegendaryMissions)
    return user, repo, tag


def _required_assets(mission_path, packaged_mode):
    """Lib filenames the mission needs in __lib__: its story.json sbslib +
    mastlib + resources, plus (packaged mode) the cosmos_dev tooling sbslib."""
    data = {}
    story = os.path.join(mission_path, "story.json")
    if os.path.isfile(story):
        try:
            with open(story) as f:
                data = json.load(f)
        except Exception:
            data = {}
    assets = list(data.get("sbslib", [])) + list(data.get("mastlib", []))
    assets += list(data.get("resources", {}).values())
    if packaged_mode:
        sbs_name = _sbs_utils_sbslib_from_story(mission_path)
        m = re.search(r"\.(v[\w.]+?)\.sbslib$", sbs_name) if sbs_name else None
        if m:
            assets.append(f"artemis-sbs.cosmos_dev.{m.group(1)}.sbslib")
    seen = set()
    return [a for a in assets if not (a in seen or seen.add(a))]


def _safe_remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _ensure_libs(mission_path, packaged_mode, do_fetch=True, refresh=False):
    """Make sure every required lib is in __lib__, downloading any missing ones
    from the matching GitHub release (curl follows the CDN redirect; a 404 body
    isn't a zip, so downloads are validated).

    With ``refresh`` every required lib is re-downloaded and overwritten -- for
    an in-place re-release under the same tag, where a same-named file on disk is
    stale. Downloads go to a temp file and only replace the existing copy once
    validated, so a release missing an asset leaves the existing copy intact.
    """
    lib_dir = os.path.join(_missions_dir(), "__lib__")
    os.makedirs(lib_dir, exist_ok=True)
    required = _required_assets(mission_path, packaged_mode)
    targets = required if refresh else [
        a for a in required if not os.path.isfile(os.path.join(lib_dir, a))]
    if not targets:
        return
    if not do_fetch and not refresh:
        raise RuntimeError(
            "Missing libraries in __lib__:\n  " + "\n  ".join(targets)
            + "\n(remove --no-fetch to download them from the GitHub release)")

    import zipfile
    from file_help import curlretrieve
    failed = []
    for asset in targets:
        parsed = _parse_asset(asset)
        if parsed is None:
            failed.append(f"{asset} (unrecognized name)")
            continue
        user, repo, tag = parsed
        url = f"https://github.com/{user}/{repo}/releases/download/{tag}/{asset}"
        dest = os.path.join(lib_dir, asset)
        tmp = dest + ".download"
        click.echo(f"fetching {asset}  <-  {url}")
        try:
            curlretrieve(url, tmp)
        except Exception as e:
            _safe_remove(tmp)
            failed.append(f"{asset} ({e})")
            continue
        if os.path.isfile(tmp) and zipfile.is_zipfile(tmp):
            os.replace(tmp, dest)                      # atomic overwrite
        else:
            _safe_remove(tmp)
            if os.path.isfile(dest):
                click.echo(f"  kept existing {asset} (not on release {repo}@{tag})")
            else:
                failed.append(f"{asset} (not found on release {repo}@{tag})")
    if failed:
        raise RuntimeError("Could not fetch from GitHub releases:\n  " + "\n  ".join(failed))


def build_settings_override(set_opts, auto_start, autoplay, players):
    """Build a settings-override dict from the CLI flags shared by debug and
    overnight. Passed to the mission via COSMOS_SETTINGS (merged by
    settings_get_defaults), so it wins over settings.yaml without editing it.
    """
    override = {}
    for kv in set_opts:
        if "=" not in kv:
            continue
        key, val = kv.split("=", 1)
        try:
            val = json.loads(val)            # true/1/"x"/[...] etc.
        except Exception:
            pass                             # leave as a string
        override[key.strip()] = val
    if auto_start:
        override["AUTO_START"] = True
    if players is not None:
        override["PLAYER_COUNT"] = players
    if autoplay:
        override["AUTO_PLAY"] = {"enable": True}
    return override


@cli.command("debug", short_help="Run a mission in debug mode with browser GUI.")
@click.argument("mission_path", default=".", required=False)
@click.option("--map", "map_arg", default=None,
              help="Map index (int) or name to auto-start  [default: show GUI picker]")
@click.option("--no-gui", is_flag=True, default=False,
              help="Run headless without the browser GUI")
@click.option("--port", default=8765, show_default=True,
              help="WebSocket port for the browser GUI")
@click.option("--tick-rate", default=60, show_default=True,
              help="Ticks per second")
@click.option("--no-fetch", is_flag=True, default=False,
              help="Don't download missing libs from GitHub releases; error instead")
@click.option("--refresh-libs", is_flag=True, default=False,
              help="Re-download all required libs from GitHub releases, overwriting "
                   "stale same-version files (use after an in-place re-release)")
@click.option("--set", "set_opts", multiple=True, metavar="KEY=VALUE",
              help="Override a setting (repeatable); VALUE is parsed as JSON, "
                   "e.g. --set AUTO_START=true --set PLAYER_COUNT=1")
@click.option("--auto-start", is_flag=True, default=False,
              help="Shortcut for --set AUTO_START=true")
@click.option("--autoplay", is_flag=True, default=False,
              help="Enable autoplay (sets AUTO_PLAY.enable=true)")
@click.option("--players", type=int, default=None,
              help="Shortcut for --set PLAYER_COUNT=N")
def debug(mission_path, map_arg, no_gui, port, tick_rate, no_fetch, refresh_libs,
          set_opts, auto_start, autoplay, players):
    """Run MISSION_PATH in debug mode using the cosmos_dev mission runner.

    MISSION_PATH defaults to the current directory.

    Without --map the server GUI is shown (map selection screen).
    Use --map to auto-start a specific map by index or name.

    Settings overrides (--set / --auto-start / --autoplay / --players) are passed
    to the mission via the COSMOS_SETTINGS env var and win over settings.yaml
    WITHOUT editing it.

    \b
    Examples:
      sbs debug .                          # GUI map picker, current dir
      sbs debug . --map 0                  # auto-start first map
      sbs debug . --no-gui --map 0         # headless
      sbs debug . --auto-start --autoplay --players 1
      sbs debug . --set DIFFICULTY=8 --set AUTO_START=true
    """
    mission_abs = os.path.abspath(mission_path)

    # Build settings overrides and hand them to the mission via COSMOS_SETTINGS
    # (settings_get_defaults merges it, highest priority, no settings.yaml edit).
    override = build_settings_override(set_opts, auto_start, autoplay, players)
    if override:
        os.environ["COSMOS_SETTINGS"] = json.dumps(override)
        click.echo(f"settings override: {override}")

    # Pull any missing libs (story.json's sbslib/mastlib/resources + the
    # cosmos_dev tooling sbslib when there's no source) from GitHub releases.
    _ensure_libs(mission_abs, _find_sbs_utils() is None,
                 do_fetch=not no_fetch, refresh=refresh_libs)
    _prepare_runner_path(mission_abs)

    from cosmos_dev.mission_runner import _run

    if map_arg is not None:
        try:
            map_val = int(map_arg)
        except ValueError:
            map_val = map_arg
    else:
        map_val = None

    _run(
        mission_folder=mission_abs,
        map_arg=map_val,
        gui=not no_gui,
        port=port,
        tick_rate=tick_rate,
    )
