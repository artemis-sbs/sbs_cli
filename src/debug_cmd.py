from cli_cmd import cli
import click
import os
import sys
import json
import glob


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


def _prepare_runner_path(mission_path):
    """Make ``cosmos_dev.mission_runner`` importable.

    Prefers the sbs_utils source folder (dev). Without it, falls back to the
    packaged sbslibs in ``__lib__`` -- the sbs_utils sbslib plus the matching
    cosmos_dev sbslib -- so ``sbs debug`` works from libs alone, no source.
    """
    src = _find_sbs_utils()
    if src is not None:
        if src not in sys.path:
            sys.path.insert(0, src)
        return

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
    for p in (sbs_path, cosmos_path):
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
def debug(mission_path, map_arg, no_gui, port, tick_rate):
    """Run MISSION_PATH in debug mode using the cosmos_dev mission runner.

    MISSION_PATH defaults to the current directory.

    Without --map the server GUI is shown (map selection screen).
    Use --map to auto-start a specific map by index or name.

    \b
    Examples:
      sbs debug .                          # GUI map picker, current dir
      sbs debug ../LegendaryMissions       # GUI map picker, explicit path
      sbs debug . --map 0                  # auto-start first map
      sbs debug . --map SecretMeeting      # auto-start by name
      sbs debug . --no-gui --map 0         # headless
      sbs debug . --port 9000              # custom port
    """
    _prepare_runner_path(os.path.abspath(mission_path))

    from cosmos_dev.mission_runner import _run

    if map_arg is not None:
        try:
            map_val = int(map_arg)
        except ValueError:
            map_val = map_arg
    else:
        map_val = None

    _run(
        mission_folder=os.path.abspath(mission_path),
        map_arg=map_val,
        gui=not no_gui,
        port=port,
        tick_rate=tick_rate,
    )
