"""Which engine executable a launching command runs.

Every command that starts Cosmos (`sbs run`, `sbs art bake`) used to hardcode
`Artemis3-x64-release.exe`, so the debug build - the one worth having when chasing a
crash or an assert - could only be run by hand. One helper, one pair of options, so the
choice reads the same everywhere:

    --debug                     Artemis3-x64-debug.exe
    --exe debug-1.3.6-A         Artemis3-x64-debug-1.3.6-A.exe (short form)
    --exe Artemis3-x64-release-1.3.4.exe
    --exe D:\\other\\install\\Artemis3-x64-release.exe
    SBS_ENGINE_EXE=debug        the same as --exe, for a whole shell session

The install root stays the working directory whichever exe is chosen: the engine
resolves its data relative to it, not to the exe.
"""
import os

import click

RELEASE_EXE = "Artemis3-x64-release.exe"
DEBUG_EXE = "Artemis3-x64-debug.exe"
_PREFIX = "Artemis3-x64-"


def cosmos_root():
    """(install root, missions folder), from this tool's own location.

    WALK UP TO THE FOLDER NAMED `missions` rather than counting levels. Deployed, this file
    lives in `…/data/missions/sbs.pyz/`, one level down. In a source checkout it is
    `…/data/missions/sbs_cli/src/`, two. Counting levels (what `sbs run` used to do)
    only worked from the zipapp.
    """
    here = os.path.dirname(os.path.realpath(__file__))
    missions = here
    while os.path.basename(missions).lower() != "missions":
        parent = os.path.dirname(missions)
        if parent == missions:                      # hit the drive root - give up cleanly
            return os.path.dirname(os.path.dirname(here)), here
        missions = parent
    return os.path.dirname(os.path.dirname(missions)), missions


def _candidates(cosmos, exe):
    """Where `--exe <exe>` could point, in the order they are tried."""
    out = [exe]                                     # a real path, absolute or relative
    out.append(os.path.join(cosmos, exe))           # a file name in the install
    base = exe[:-4] if exe.lower().endswith(".exe") else exe
    if not base.lower().startswith(_PREFIX.lower()):
        out.append(os.path.join(cosmos, f"{_PREFIX}{base}.exe"))   # debug, release-1.3.4
    return out


def _installed(cosmos):
    try:
        return sorted(f for f in os.listdir(cosmos)
                      if f.lower().startswith(_PREFIX.lower()) and f.lower().endswith(".exe"))
    except OSError:
        return []


def resolve_engine_exe(cosmos, debug=False, exe=None):
    """Absolute path of the engine exe to launch, or a ClickException naming what exists.

    ABSOLUTE, never a bare name: CreateProcess only searches the working directory when
    `NoDefaultCurrentDirectoryInExePath` is unset, and MSYS2/Git-Bash exports it.
    """
    if debug and exe:
        raise click.ClickException("pass --debug or --exe, not both")
    # The env var is read HERE rather than as click's `envvar=`, so `--debug` still wins
    # over a session-wide SBS_ENGINE_EXE instead of colliding with it.
    if not debug and not exe:
        exe = os.environ.get("SBS_ENGINE_EXE") or None
    if exe:
        tried = _candidates(cosmos, exe)
    else:
        tried = [os.path.join(cosmos, DEBUG_EXE if debug else RELEASE_EXE)]
    for path in tried:
        if os.path.isfile(path):
            return os.path.abspath(path)
    have = _installed(cosmos)
    hint = ("\n  installed: " + ", ".join(have)) if have else ""
    raise click.ClickException(f"engine not found: {tried[-1] if not exe else exe}{hint}")


def engine_options(f):
    """`--debug` and `--exe` on a command. The function receives `debug` and `exe`."""
    f = click.option("--exe", "exe", default=None, metavar="EXE",
                     help="Engine executable: a path, a file name in the install, or a "
                          "short form like `debug` or `release-1.3.4` (expands to "
                          "Artemis3-x64-<form>.exe). Env: SBS_ENGINE_EXE.")(f)
    f = click.option("--debug", is_flag=True,
                     help=f"Run the engine's debug build ({DEBUG_EXE}).")(f)
    return f
