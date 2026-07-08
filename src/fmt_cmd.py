import click
import os
import sys
import glob

from cli_cmd import cli, zipapp_dir
from lint_cmd import _prefer_working_tree_sbs_utils


def _load_format(missions, mission):
    """Import `format_file` - working tree first, else the mission's sbslib."""
    _prefer_working_tree_sbs_utils(missions, mission)
    sys.path.insert(0, mission)
    try:
        from sbs_utils.procedural.amd_fmt import format_file
        return format_file
    except Exception:
        from compile_cmd import sbs_lib_import
        sbs_lib_import(missions, mission)
        from sbs_utils.procedural.amd_fmt import format_file
        return format_file


@cli.command(short_help="Format a mission's AMD (.amd) files")
@click.argument("folder", default=".")
@click.option("--check", is_flag=True,
              help="Exit 1 if any file is not already formatted; write nothing.")
def fmt(folder, check):
    """Canonically format the .amd files in a mission FOLDER.

    Normalizes whitespace, heading spacing, `---` fences, and blank lines - it
    never reflows prose and does not change the parsed model. By default it writes
    changes in place; with --check it only reports and exits 1 if any file differs.
    """
    missions = zipapp_dir
    mission = os.path.join(missions, folder)
    if not os.path.isdir(mission):
        mission = folder
    if not os.path.isdir(mission):
        print(f"ERROR: not a folder: {folder}")
        raise SystemExit(2)

    try:
        format_file = _load_format(missions, mission)
    except Exception as e:
        print(f"ERROR: could not load sbs_utils to format ({e})")
        raise SystemExit(2)

    amd_files = sorted(glob.glob(os.path.join(mission, "**", "*.amd"), recursive=True))
    if not amd_files:
        print(f"No .amd files under {mission}")
        return

    n_changed = 0
    for path in amd_files:
        changed, _ = format_file(path, write=not check)
        if changed:
            n_changed += 1
            rel = os.path.relpath(path, mission)
            print(f"{'would reformat' if check else 'formatted'}: {rel}")

    if not n_changed:
        print(f"{len(amd_files)} file(s): already formatted")
    if check and n_changed:
        raise SystemExit(1)
