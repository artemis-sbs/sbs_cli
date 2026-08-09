import click
import json
import os
import zipfile

from cli_cmd import cli, zipapp_dir
from file_help import zipdir
from media_cmd import unpack_all, prune_media, pinned_packs
from pathlib import Path

def lib_get_json(folder):
    """Build library command
    This will look for a __lib__.json file and create any needed libraries and put them in __lib__
    This can be an sbslib, mastlib, or a resource zip file
    """
    working_directory = zipapp_dir
    deps_file = Path(working_directory).resolve() / folder / "__lib__.json"

    if not os.path.exists(deps_file):
        return

    libs = {}
    try:
        with open(deps_file, 'r') as f:
            libs = json.load(f)

    except Exception as e:
        print(f"ERROR: building libs/addons no __lib__.json?\n{e}")
        return {}
    return libs



def _stamp_amd(zip_file_name, lib_dir, mission_root, version):
    """Record, inside the mastlib, which of its .amd files linted clean.

    The headless `--test` gate reads this and SKIPS a file whose bytes it already
    knows are clean, so the stamp is the gate's cache rather than a second opinion.
    A file the stamp does not cover is simply linted - which is the right answer for
    the case a stamp structurally cannot see: a mission-folder .amd shadowing this
    addon's copy, which is the file an author is actually editing.

    Lint ERRORS are reported loudly and do NOT stop the build. A blocked release on
    a corpus that has always carried warnings is worse than a noisy one, and the
    stamp still records the errors so the gate lints those files rather than
    trusting them.
    """
    try:
        from sbs_utils.procedural.amd_stamp import amd_stamp_for_folder, STAMP_NAME
    except Exception:
        return          # no sbs_utils on the path: build the zip, skip the stamp
    try:
        stamp, findings = amd_stamp_for_folder(str(lib_dir), str(mission_root), version)
    except Exception as e:
        print(f"WARNING: could not lint .amd for {os.path.basename(zip_file_name)}: {e}")
        return
    if stamp is None:
        return          # this addon ships no .amd
    bad = [(p, f) for p, f in findings if f.is_error()]
    for path, f in bad:
        print(f"AMD ERROR {os.path.relpath(path, str(mission_root))}:{f.line}: "
              f"{f.message} [{f.code}]")
    if bad:
        print(f"WARNING: {os.path.basename(zip_file_name)} packages "
              f"{len(bad)} .amd error(s) - the mission will FAIL its --test gate")
    try:
        with zipfile.ZipFile(zip_file_name, "a", zipfile.ZIP_DEFLATED) as z:
            z.writestr(STAMP_NAME, json.dumps(stamp, indent=1, sort_keys=True))
    except Exception as e:
        print(f"WARNING: could not write {STAMP_NAME}: {e}")


def lib_impl(folder, user):
    """Build library command
    This will look for a __lib__.json file and create any needed libraries and put them in __lib__
    This can be an sbslib, mastlib, or a resource zip file
    """
    working_directory = zipapp_dir
    libs = lib_get_json(folder)
    # Fetch sbs libs
    version = libs.get("version")
    if version is None:
        print(f"ERROR: version is needed in __lib__.json to build libraries ")
        return
    #
    # Roll through keys and use that as the extension
    #
    repo = folder
    for key, values in libs.items():
        if key == "version":
            # v = version_file_contents(values)
            # if v is None:
            #     continue
            # version_file = Path(working_directory).resolve() / folder / folder / "version__.py"
            # with open(version_file, "w") as f:
            #     f.write(v)
            continue
        ext = key
        for folder_path in values:
            lib_dir = Path(working_directory).resolve() / folder / folder_path
            # NEVER build from a source folder that is not there. `fetch` calls this
            # straight after downloading, and a fetched copy can legitimately lack a
            # folder the manifest lists - `media/` is `export-ignore`d out of the GitHub
            # archive, because the art travels as its own pack. Zipping a missing folder
            # writes an EMPTY zip over the real one in `__lib__`, the unpacker sees the
            # changed listing and replaces the shared art with nothing, and every mission
            # reading that pack goes blank. Skip, and say why.
            if not lib_dir.is_dir():
                print(f"SKIP {key} '{folder_path}': no such folder in {folder} "
                      f"(kept whatever is already in __lib__)")
                continue
            if not any(lib_dir.rglob("*")):
                print(f"SKIP {key} '{folder_path}': folder is empty "
                      f"(kept whatever is already in __lib__)")
                continue
            if key == "sbslib":
                # sbslibs are named by package (folder_path) with the repo
                # dropped, to match the GitHub release assets (e.g.
                # artemis-sbs.cosmos_dev.<ver>.sbslib), and they keep the package
                # dir at the zip root so they import (zipimport has no namespace
                # packages; contents-at-root would fail to import).
                zip_file_name = f"{working_directory}/__lib__/{user}.{folder_path}.{version}.{ext}"
                zipdir(lib_dir, zip_file_name, folder_path)
            else:
                # mastlib / resource zips are repo-namespaced and flat.
                zip_file_name = f"{working_directory}/__lib__/{user}.{repo}.{folder_path}.{version}.{ext}"
                zipdir(lib_dir, zip_file_name)
                _stamp_amd(zip_file_name, lib_dir,
                           Path(working_directory).resolve() / folder, version)
            
            
            #print(f"Compressing {lib_dir} into  {zip_file_name}")

    # A media pack is art, and art wants to live ONCE: unpack it beside the libraries
    # rather than leaving every consuming mission to hold its own copy. Stamped, so this
    # is free when nothing changed.
    try:
        lib = os.path.join(working_directory, "__lib__")
        pinned = pinned_packs(working_directory)
        unpack_all(lib, quiet=True, pinned=pinned)
        prune_media(lib, pinned)
    except Exception as e:
        print(f"WARNING: could not unpack media: {e}")


def version_file_contents(version):
    if version is None:
        return None
    v = version.split(".")
    print(version)
    if len(v)!=3:
        return None
    v[0] = v[0][1:]
    return f"""
__version = ({v[0]},{v[1]},{v[2]})
def version_get():
    return __version

def version_get_major():
    return __version[0]

def version_get_minor():
    return __version[1]

def version_get_build():
    return __version[2]

"""



@cli.command(short_help="Build libraries/addons.")
@click.argument("folder", default="LegendaryMissions")
@click.option('-u', '--user', default="artemis-sbs", show_default=True, help="Specify The github user/organization.")
def lib(folder, user):
    lib_impl(folder, user)

