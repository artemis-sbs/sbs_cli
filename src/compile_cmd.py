import click
import json
import os

from cli_cmd import cli, zipapp_dir
from file_help import zipdir
from pathlib import Path

def sbs_lib_import(mission_dir, script_dir):
    import sys
    import os
    import json
    
    story_settings = os.path.join(script_dir,"story.json")
    lib_dir = os.path.join(mission_dir,"__lib__")
    with open(story_settings, 'r') as file:
        data = json.load(file)
        if data is None:
            raise Exception("Missing story.json needed to load libraries")
        sbslibs = data.get("sbslib", [])
        for file in sbslibs:
            f = os.path.join(lib_dir, file)
            if not os.path.isfile(f):
                raise Exception(f"Missing library: {f}")
            sys.path.insert(0, f) 


def report_compile_errors(errors):
    """Print what `mast_run` reported and say whether it compiled.

    `mast_run(..., compile_only=True)` RETURNS its error list; throwing that away meant a
    mission with a broken .mast printed nothing and exited 0. Anything scripting this - CI
    for the mission templates, a pre-commit hook - was reading success off a compile that
    never happened.
    """
    if not errors:
        return True
    for e in errors:
        print(e)
    print(f"FAILED: {len(errors)} compile error(s)")
    return False


def compile_impl(folder, compile_only = True, is_sbs=True):
    """Compile (or run) a mission. Returns True when it compiled cleanly."""
    missions = zipapp_dir

    try:
        # Prefer a working-tree sbs_utils, exactly as lint/docs/fmt do. Without
        # this, compile checked the RELEASED sbslib while lint checked your edits,
        # so the two could disagree about the same mission and nothing said why.
        # Imported here rather than at module scope: lint_cmd imports
        # `sbs_lib_import` FROM this module, so the other direction is circular.
        from lint_cmd import _prefer_working_tree_sbs_utils
        _prefer_working_tree_sbs_utils(missions, os.path.join(missions, folder))
        try:
            # IMPORT it, do not merely put it on the path. `import script` below
            # reaches PyAddons/sbslibs.py, which inserts the mission's .sbslib at
            # sys.path[0] - after us - so the release would shadow the working
            # tree and compile would quietly check different code from lint.
            # Binding it in sys.modules first settles the question. lint_cmd wins
            # the same race the same way, by importing immediately.
            import sbs_utils  # noqa: F401
        except ImportError:
            pass               # no working tree; sbslibs will supply it below

        data_path = os.path.join(missions, "..")
        exe_path = os.path.join(data_path, "..")
        py_addons = os.path.join(exe_path, "PyAddons")

        mission = os.path.join(missions, folder)
        story = os.path.join(mission, "story.mast")
        import sys
        
        sys.path.insert(0, py_addons) 
        sys.path.insert(0, mission) 
        if not is_sbs:        
            sbs_lib_import(missions, mission)

            from sbs_utils import fs
            fs.exe_dir = exe_path
            fs.script_dir = mission
            
            from sbs_utils.mast.mast_run import mast_run
            return report_compile_errors(mast_run(story, compile_only))


        import script

        # The mock has to be imported BEFORE story_nodes, and on every path -
        # including plain compile, which never touches the `sbs` name itself.
        # Importing it registers `sys.modules["sbs"]` (cosmos_dev/mock/sbs.py),
        # and library code compiled below does a bare `import sbs`. So this is
        # not, as it first appears, dead weight on the compile path: it is the
        # only thing that makes `sbs` resolvable outside the engine.
        #
        # It was `sbs_utils.mock` until that package became `cosmos_dev.mock` on
        # 2026-06-19, and this line was never updated - which broke plain
        # `sbs compile` for everyone for two months. cosmos_dev is dev-only and no
        # mission's story.json declares it, so it has to be put on the path
        # deliberately; debug_cmd already does that, preferring the source tree,
        # falling back to the version-matched sbslib pair, and naming what to
        # fetch when it cannot find either.
        from debug_cmd import _prepare_runner_path
        _prepare_runner_path(mission)
        from cosmos_dev.mock import sbs

        import sbs_utils.mast_sbs.story_nodes

        # The --terminal branch has always set these; this one never did, because
        # it never got far enough to need them. Without exe_dir, `fs` falls back to
        # the directory of sys.executable - PyRuntime - and every library path
        # comes out as `...\PyRuntime/data/missions\__lib__\...`, so a mission
        # that compiles fine reports every mastlib missing.
        from sbs_utils import fs
        fs.exe_dir = exe_path
        fs.script_dir = mission

        ### is_sbs:
        if compile_only:
            import sbslibs
            from sbs_utils.mast.mast_run import mast_run
            return report_compile_errors(mast_run(story, compile_only))

        
        
        sim = sbs.create_new_sim()

        from sbs_utils.helpers import FrameContext, Context, FakeEvent
        from sbs_utils.agent import Agent
        from sbs_utils.handlerhooks import cosmos_event_handler

        Agent.SHARED.set_inventory_value("sim", sim)
        ctx = Context(sim, sbs, FakeEvent())
        #page = StoryPage()
        #FrameContext.page = page
        FrameContext.context = ctx
        
        event = FakeEvent(0, "mission_tick")

        import time
        while True:
            cosmos_event_handler(sim,event)
            sim._time_tick_counter += 1
            time.sleep(0.001)



    except RuntimeError as e:
        # debug_cmd raises this with the missing library named and the command to
        # get it. That is already the actionable message; do not bury it.
        print(e)
        return False
    except Exception as e:
        print(e)
        if isinstance(e, (ImportError, OSError)) or not _looks_like_mast_error(e):
            # An environment failure, not a mission one. The bare message alone -
            # "No module named 'sbs_utils.mock'", with no file and no line - is
            # what made this bug take a full investigation to place.
            import traceback
            traceback.print_exc()
        return False

    return True


def _looks_like_mast_error(e):
    """Is this a mission problem rather than an environment one?

    Only used to decide whether a traceback is worth printing: a MAST compile
    error is about the mission and the message is the whole story, while an
    import or path failure is about this machine and the message alone is not
    enough to act on."""
    return e.__class__.__module__.startswith("sbs_utils")


@cli.command(short_help="MAST Compile")
@click.argument("folder", default="LegendaryMissions")
@click.option('-t', '--terminal', is_flag=True)
@click.option('-r', '--run', is_flag=True)
def compile(folder, run, terminal):
    # Exit non-zero when it did not compile, so this can be used as a gate.
    if not compile_impl(folder, not run, not terminal):
        raise SystemExit(1)
    
