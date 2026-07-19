from cli_cmd import cli
import click
import os
import sys
import contextlib

# Reuse the debug command's library bootstrap (source tree in dev, else the
# packaged sbslibs from __lib__) so cosmos_dev.* is importable.
from debug_cmd import _ensure_libs, _prepare_runner_path, _find_sbs_utils


@cli.command("dap", short_help="MAST source debugger (Debug Adapter Protocol over stdio).")
@click.argument("mission_path", default=".", required=False)
@click.option("--mast", "mast_file", default=None,
              help="The .mast to debug  [default: <mission>/story.mast]")
@click.option("--no-fetch", is_flag=True, default=False,
              help="Don't download missing libs from GitHub releases; error instead")
def dap(mission_path, mast_file, no_fetch):
    """Speak the Debug Adapter Protocol on stdin/stdout so an editor (e.g. VS
    Code) can set breakpoints and step through a .mast.

    \b
    Launch mode: compiles and runs the target .mast under the mock, parking the
    MAST tick thread at breakpoints. stdout carries the DAP wire protocol, so all
    diagnostics are sent to stderr.

    \b
    VS Code wires this up via a `debuggers` contribution whose adapter runs:
      sbs dap <mission_path>
    with `program` in the launch config selecting the .mast to debug.
    """
    mission_abs = os.path.abspath(mission_path)
    default_mast = (os.path.abspath(mast_file) if mast_file
                    else os.path.join(mission_abs, "story.mast"))

    # Library prep echoes progress; that MUST NOT land on stdout (the DAP stream).
    with contextlib.redirect_stdout(sys.stderr):
        _ensure_libs(mission_abs, _find_sbs_utils() is None, do_fetch=not no_fetch)
        _prepare_runner_path(mission_abs)
        if mission_abs not in sys.path:
            sys.path.insert(0, mission_abs)

    from cosmos_dev.mast_dap import run_stdio, file_runner_factory
    run_stdio(file_runner_factory(default_mast))
