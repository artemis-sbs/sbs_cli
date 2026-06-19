from cli_cmd import cli
import click
import os
import sys


def _find_sbs_utils():
    """Locate sbs_utils/ relative to the missions folder.

    Works in both dev (dev.pyz inside sbs_cli/) and deployed (sbs.pyz inside
    missions/) modes by walking up from __file__ until we reach the missions
    folder, then looking for sbs_utils/ as a sibling.
    """
    here = os.path.dirname(os.path.realpath(__file__))
    if os.path.basename(here) != "missions":
        here = os.path.dirname(here)
    candidate = os.path.join(here, "sbs_utils")
    if os.path.isdir(candidate):
        return candidate
    raise RuntimeError(f"sbs_utils not found — expected at {candidate!r}")


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
    sbs_utils_path = _find_sbs_utils()
    if sbs_utils_path not in sys.path:
        sys.path.insert(0, sbs_utils_path)

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
