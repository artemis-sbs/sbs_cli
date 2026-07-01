from cli_cmd import cli
import click
import os
import sys
import subprocess

from debug_cmd import (_ensure_libs, _find_sbs_utils, _runner_lib_paths,
                       _missions_dir)

# Bootstrap to launch on PYTHONPATH-deaf embedded Python (PyRuntime's python._pth
# makes it ignore PYTHONPATH). Lib paths come via COSMOS_DEV_LIBS and are injected
# into sys.path before running the target module. Same trick as overnight_cmd.
_BOOT = (
    "import sys,os,runpy;"
    "L=os.environ.get('COSMOS_DEV_LIBS','');"
    "sys.path[:0]=[p for p in L.split(os.pathsep) if p];"
    "m=sys.argv[1];sys.argv=[m]+sys.argv[2:];"
    "runpy.run_module(m,run_name='__main__')"
)


def _default_cosmos_dir():
    """Cosmos install root (holds data/graphics), i.e. the parent of the missions
    folder's parent: .../Cosmos-x/data/missions -> .../Cosmos-x."""
    return os.path.dirname(os.path.dirname(_missions_dir()))


def _env_with_libs(mission_abs, no_fetch, refresh_libs):
    """Ensure the dev libs exist and return an env with COSMOS_DEV_LIBS set so the
    child can import cosmos_dev.* (no sbs_utils source needed)."""
    _ensure_libs(mission_abs, _find_sbs_utils() is None,
                 do_fetch=not no_fetch, refresh=refresh_libs)
    env = dict(os.environ)
    env["COSMOS_DEV_LIBS"] = os.pathsep.join(_runner_lib_paths(mission_abs))
    return env


@cli.command("web",
             context_settings=dict(ignore_unknown_options=True),
             short_help="Serve MAST //web pages from a running engine.")
@click.argument("mission_path", default=".", required=False)
@click.option("--host", default="127.0.0.1", help="Bind host [127.0.0.1]")
@click.option("--port", type=int, default=8770, help="Bind port [8770]")
@click.option("--engine", "engines", multiple=True, metavar="NAME=DIR",
              help="Named engine (repeatable): /web/NAME/<page> routes here. "
                   "Omit to serve MISSION_PATH as the default (/web/<page>).")
@click.option("--cosmos-dir", default=None,
              help="Cosmos install root for serving /data/graphics images "
                   "[auto-detected]")
@click.option("--refresh-libs", is_flag=True, default=False,
              help="Re-download the dev libs from GitHub releases first")
@click.option("--no-fetch", is_flag=True, default=False,
              help="Don't download missing libs; error instead")
@click.argument("proxy_args", nargs=-1, type=click.UNPROCESSED)
def web(mission_path, host, port, engines, cosmos_dir, refresh_libs, no_fetch,
        proxy_args):
    """Serve MAST //web pages from a RUNNING engine over the dev queue.

    The engine must already be running the mission with the dev queue enabled
    (drop a dev_queue.enable file in the mission dir, or set COSMOS_DEV_QUEUE).
    This is an always-on server: start it before or after the engine; it re-arms
    when the engine appears and survives restarts. Open
    http://<host>:<port>/web/<page> in a browser.

    \b
    Examples:
      sbs web .                       # serve this mission at /web/<page>
      sbs web LegendaryMissions --port 8770
      sbs web --engine a=missionA --engine b=missionB   # /web/a/... , /web/b/...
    """
    mission_abs = os.path.abspath(mission_path)
    env = _env_with_libs(mission_abs, no_fetch, refresh_libs)

    args = []
    if not engines:
        args.append(mission_abs)        # default (nameless) engine = this mission
    args += ["--host", host, "--port", str(port)]
    for spec in engines:
        args += ["--engine", spec]
    args += ["--cosmos-dir", cosmos_dir or _default_cosmos_dir()]
    args += list(proxy_args)

    cmd = [sys.executable, "-u", "-c", _BOOT, "cosmos_dev.webproxy.proxy", *args]
    raise SystemExit(subprocess.call(cmd, env=env))


@cli.command("web-static",
             short_help="Render a MAST //web page to a standalone HTML file.")
@click.argument("mission_path")
@click.argument("page")
@click.option("-o", "--out", default=None, help="Output .html file [stdout]")
@click.option("--query", "queries", multiple=True, metavar="K=V",
              help="Seed a page variable (repeatable)")
@click.option("--ticks", type=int, default=6,
              help="Render ticks to let the layout build [6]")
@click.option("--refresh-libs", is_flag=True, default=False,
              help="Re-download the dev libs from GitHub releases first")
@click.option("--no-fetch", is_flag=True, default=False,
              help="Don't download missing libs; error instead")
def web_static(mission_path, page, out, queries, ticks, refresh_libs, no_fetch):
    """Render //web/PAGE from a running engine to a self-contained HTML file.

    One-shot, no live session - great for a read-only dashboard/report you serve
    from any web server. The engine must be running MISSION_PATH with the dev
    queue enabled.

    \b
    Examples:
      sbs web-static . scores -o scores.html --query title=Standings
    """
    mission_abs = os.path.abspath(mission_path)
    env = _env_with_libs(mission_abs, no_fetch, refresh_libs)

    args = [mission_abs, page, "--ticks", str(ticks)]
    if out:
        args += ["-o", out]
    for q in queries:
        args += ["--query", q]

    cmd = [sys.executable, "-u", "-c", _BOOT, "cosmos_dev.webproxy.snapshot", *args]
    raise SystemExit(subprocess.call(cmd, env=env))
