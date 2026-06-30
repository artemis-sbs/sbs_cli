from cli_cmd import cli
import click
import os
import sys
import json
import subprocess

from debug_cmd import (_ensure_libs, _find_sbs_utils, _runner_lib_paths,
                       build_settings_override)


@cli.command("overnight",
             context_settings=dict(ignore_unknown_options=True),
             short_help="Run an overnight soak (cosmos_dev.overnight_runner).")
@click.argument("mission_path", default="LegendaryMissions", required=False)
@click.option("--refresh-libs", is_flag=True, default=False,
              help="Re-download all required libs from GitHub releases first "
                   "(after an in-place re-release)")
@click.option("--no-fetch", is_flag=True, default=False,
              help="Don't download missing libs from GitHub releases; error instead")
@click.option("--set", "set_opts", multiple=True, metavar="KEY=VALUE",
              help="Override a setting (repeatable); VALUE is parsed as JSON")
@click.option("--auto-start", is_flag=True, default=False,
              help="Shortcut for --set AUTO_START=true")
@click.option("--autoplay", is_flag=True, default=False,
              help="Enable autoplay (sets AUTO_PLAY.enable=true)")
@click.option("--players", type=int, default=None,
              help="Shortcut for --set PLAYER_COUNT=N")
@click.argument("runner_args", nargs=-1, type=click.UNPROCESSED)
def overnight(mission_path, refresh_libs, no_fetch,
              set_opts, auto_start, autoplay, players, runner_args):
    """Soak-test MISSION_PATH under autoplay via cosmos_dev.overnight_runner.

    MISSION_PATH is relative to the current directory (run from the missions
    folder, like `sbs debug`). Ensures the dev libraries are present (downloading
    from GitHub releases when there is no sbs_utils source), then runs the soak.
    Extra options pass straight through to overnight_runner: --map, --gui,
    --port, --hours, --max-runs, --stall-minutes, --reset, --state, --log, etc.

    \b
    Examples:
      sbs overnight LegendaryMissions --map 0 --gui
      sbs overnight LegendaryMissions --hours 8 --reset
      sbs overnight LegendaryMissions --refresh-libs --max-runs 50
    """
    mission_abs = os.path.abspath(mission_path)
    _ensure_libs(mission_abs, _find_sbs_utils() is None,
                 do_fetch=not no_fetch, refresh=refresh_libs)

    # overnight_runner spawns child mission_runner processes, which import
    # cosmos_dev.* -- children inherit PYTHONPATH, not this process's sys.path,
    # so the libs must go on PYTHONPATH.
    env = dict(os.environ)
    paths = _runner_lib_paths(mission_abs)
    if env.get("PYTHONPATH"):
        paths = paths + [env["PYTHONPATH"]]
    env["PYTHONPATH"] = os.pathsep.join(paths)

    # Settings overrides reach the mission via COSMOS_SETTINGS; children inherit
    # the env, so this applies to every soak cycle without editing settings.yaml.
    override = build_settings_override(set_opts, auto_start, autoplay, players)
    if override:
        env["COSMOS_SETTINGS"] = json.dumps(override)
        click.echo(f"settings override: {override}")

    cmd = [sys.executable, "-u", "-m", "cosmos_dev.overnight_runner",
           mission_abs, *runner_args]
    raise SystemExit(subprocess.call(cmd, env=env))
