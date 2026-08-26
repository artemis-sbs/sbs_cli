"""`sbs soak` - run a mission's conformance soak, or generate the scenario for one.

WHY A COMMAND AND NOT JUST THE MODULE. `python -m cosmos_dev.tools.mission_soak` works and
will keep working, but it needs the lib paths already sorted and it is not something you
find by typing `sbs --help`. Worth knowing while reading this: `sbs debug` exposes NONE of
the conformance flags (`--test`, `--exercise`, `--soak`), and the docs advertised
`sbs debug . --test 30` for a long time, which never worked. This is the command that was
missing.

Two subcommands rather than a pile of flags, because they are two different jobs:

    sbs soak init  <mission>              # write starter scenarios, one per @map
    sbs soak bless <mission> <scenario>   # teach the ratchet what "working" looks like
    sbs soak run   <mission> <scenario>   # run it, unattended, with a real exit code

Both delegate to cosmos_dev and pass unknown options straight through, exactly as
`sbs overnight` does - so every flag the underlying tool grows is available here the day
it lands, without touching this file.
"""
from cli_cmd import cli
import click
import json
import os
import subprocess
import sys

from debug_cmd import (_ensure_libs, _find_sbs_utils, _runner_lib_paths,
                       build_settings_override)

# PyRuntime's embedded Python ships a python._pth that makes it ignore PYTHONPATH, so lib
# paths travel in COSMOS_DEV_LIBS and get injected into sys.path here. The soak's own child
# processes inherit the variable and bootstrap themselves the same way.
_BOOT = (
    "import sys,os,runpy;"
    "L=os.environ.get('COSMOS_DEV_LIBS','');"
    "sys.path[:0]=[p for p in L.split(os.pathsep) if p];"
    "m=sys.argv[1];sys.argv=[m]+sys.argv[2:];"
    "runpy.run_module(m,run_name='__main__')"
)


def _env_for(mission_abs, set_opts=(), auto_start=False, autoplay=False, players=None):
    env = dict(os.environ)
    env["COSMOS_DEV_LIBS"] = os.pathsep.join(_runner_lib_paths(mission_abs))
    override = build_settings_override(set_opts, auto_start, autoplay, players)
    if override:
        # Reaches the mission via COSMOS_SETTINGS; children inherit it, so this applies to
        # every iteration without editing settings.yaml. A scenario's own `settings:` is
        # the better home for anything permanent.
        env["COSMOS_SETTINGS"] = json.dumps(override)
        click.echo(f"settings override: {override}")
    return env


@cli.group("soak", invoke_without_command=True,
           short_help="Run or create a mission conformance soak.")
@click.pass_context
def soak(ctx):
    """Soak a mission against a scenario, or generate a scenario to soak with.

    A soak accepts the mission's quests, drives their declared goals, and checks the
    result against a ratcheting baseline - so it fails when the mission does LESS than it
    used to, rather than only when something raises.

    \b
    Typical first run for a mission that has never been soaked:
      sbs soak init  LegendaryMissions
      sbs soak bless LegendaryMissions peacetime --runs 3
      sbs soak run   LegendaryMissions peacetime --hours 8

    \b
    In the real engine (same scenario, same assertions):
      sbs soak run LegendaryMissions peacetime --engine --runs 6
    """
    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


@soak.command("init", context_settings=dict(ignore_unknown_options=True),
              short_help="Write starter soak scenarios for a mission.")
@click.argument("mission_path", default=".", required=False)
@click.argument("map_name", default=None, required=False)
@click.option("--no-fetch", is_flag=True, default=False,
              help="Don't download missing libs from GitHub releases; error instead")
@click.option("--refresh-libs", is_flag=True, default=False,
              help="Re-download all required libs from GitHub releases first")
@click.argument("extra", nargs=-1, type=click.UNPROCESSED)
def soak_init(mission_path, map_name, no_fetch, refresh_libs, extra):
    """Write `<mission>/soaks/<map>.yaml`, one per @map, and exit.

    Compiles the mission so it can read each map's REAL option keys from its `Properties:`
    metadata, and censuses the mission's `.amd` quests - marking every goal as one the
    pilot can drive or one that completes on the mission's own signal. Never overwrites an
    existing scenario.

    \b
      sbs soak init LegendaryMissions
      sbs soak init LegendaryMissions siege
    """
    mission_abs = os.path.abspath(mission_path)
    _ensure_libs(mission_abs, _find_sbs_utils() is None,
                 do_fetch=not no_fetch, refresh=refresh_libs)
    args = ["--soak-init"]
    if map_name:
        args.append(map_name)
    cmd = [sys.executable, "-u", "-c", _BOOT,
           "cosmos_dev.mission_runner", mission_abs, *args, *extra]
    raise SystemExit(subprocess.call(cmd, env=_env_for(mission_abs)))


@soak.command("run", context_settings=dict(ignore_unknown_options=True),
              short_help="Run a soak scenario, unattended, with a real exit code.")
@click.argument("mission_path")
@click.argument("scenario")
@click.option("--no-fetch", is_flag=True, default=False,
              help="Don't download missing libs from GitHub releases; error instead")
@click.option("--refresh-libs", is_flag=True, default=False,
              help="Re-download all required libs from GitHub releases first")
@click.option("--set", "set_opts", multiple=True, metavar="KEY=VALUE",
              help="Override a setting (repeatable); VALUE is parsed as JSON")
@click.option("--auto-start", is_flag=True, default=False,
              help="Shortcut for --set AUTO_START=true")
@click.option("--autoplay", is_flag=True, default=False,
              help="Enable autoplay. Rarely wanted here - the pilot drives, and autoplay "
                   "is what made repeated runs diverge")
@click.option("--players", type=int, default=None,
              help="Shortcut for --set PLAYER_COUNT=N")
@click.option("--profile", default=None, metavar="NAME",
              help="Use <mission>/profiles/NAME.yaml, overriding the scenario's. Honored "
                   "by both legs - the mock gets --profile, the engine gets profile=")
@click.argument("soak_args", nargs=-1, type=click.UNPROCESSED)
def soak_run(mission_path, scenario, no_fetch, refresh_libs,
             set_opts, auto_start, autoplay, players, profile, soak_args):
    """Run SCENARIO against MISSION_PATH until it finishes, or for --hours.

    Keeps every iteration's evidence under `<mission>/soaks/runs/`, and exits non-zero
    when one regresses (0 pass, 1 regressed, 2 the build changed mid-soak so the numbers
    are void, 3 nothing ran).

    Runs against an auto-managed copy of the mission, because a soak truncates
    `mast.runtime.log` in the mission directory and would otherwise destroy the log of a
    session somebody is playing.

    Extra options pass through to `cosmos_dev.tools.mission_soak`: --hours, --runs,
    --seed, --seconds, --engine, --timeout, --artifacts, --use-working-tree, --verbose.

    \b
      sbs soak run LegendaryMissions peacetime --hours 8
      sbs soak run LegendaryMissions peacetime --runs 3
      sbs soak run LegendaryMissions peacetime --engine --runs 6
    """
    mission_abs = os.path.abspath(mission_path)
    _ensure_libs(mission_abs, _find_sbs_utils() is None,
                 do_fetch=not no_fetch, refresh=refresh_libs)
    env = _env_for(mission_abs, set_opts, auto_start, autoplay, players)
    extra = list(soak_args)
    if profile:
        extra += ["--profile", profile]
    cmd = [sys.executable, "-u", "-c", _BOOT,
           "cosmos_dev.tools.mission_soak", mission_abs, scenario, *extra]
    raise SystemExit(subprocess.call(cmd, env=env))


@soak.command("bless", context_settings=dict(ignore_unknown_options=True),
              short_help="Fold a good run into the scenario's ratchet baseline.")
@click.argument("mission_path")
@click.argument("scenario")
@click.option("--runs", default=8, show_default=True,
              help="How many runs to bless. MORE IS BETTER and 3 is too few: the baseline "
                   "demands what EVERY blessed run reached, so a small sample bakes in "
                   "whatever it happened to hit. Measured - three blessed runs all caught "
                   "an intermittent route, and every run afterwards failed on it")
@click.option("--no-fetch", is_flag=True, default=False,
              help="Don't download missing libs from GitHub releases; error instead")
@click.option("--profile", default=None, metavar="NAME",
              help="Use <mission>/profiles/NAME.yaml. Bless with the SAME profile you "
                   "will run with - a baseline blessed under different settings demands "
                   "things the run may never reach")
@click.argument("soak_args", nargs=-1, type=click.UNPROCESSED)
def soak_bless(mission_path, scenario, runs, no_fetch, profile, soak_args):
    """Run SCENARIO --runs times, folding each into `<scenario>.baseline.json`.

    The baseline is what turns "nothing raised" into a real check: after blessing, a run
    fails when it completes FEWER quests or enters FEWER routes than every blessed run
    did. It can only ever be changed deliberately, by this command.

    Bless a few runs before relying on it - a one-run baseline over-fits that run's luck,
    and measured, reported 17 routes as regressed on the next run purely from variance.

    \b
      sbs soak bless LegendaryMissions peacetime --runs 3
    """
    mission_abs = os.path.abspath(mission_path)
    _ensure_libs(mission_abs, _find_sbs_utils() is None, do_fetch=not no_fetch)
    env = _env_for(mission_abs)
    # One process per bless so a crash mid-way still leaves the earlier ones folded in.
    for n in range(1, runs + 1):
        click.echo(f"[bless] run {n}/{runs}")
        extra = list(soak_args)
        if profile:
            extra += ["--profile", profile]
        cmd = [sys.executable, "-u", "-c", _BOOT,
               "cosmos_dev.tools.mission_soak", mission_abs, scenario,
               "--runs", "1", "--bless", *extra]
        rc = subprocess.call(cmd, env=env)
        if rc not in (0, 1):
            # 2 = build changed, 3 = nothing ran. Neither is worth blessing further.
            raise SystemExit(rc)
    click.echo(f"[bless] baseline updated from {runs} run(s)")
