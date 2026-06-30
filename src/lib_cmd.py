import click
import json
import os

from cli_cmd import cli, zipapp_dir
from file_help import zipdir
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
            zip_file_name = f"{working_directory}/__lib__/{user}.{repo}.{folder_path}.{version}.{ext}"
            # Special case for sbs_utils, because history: sbs libs whose folder
            # matches the repo drop the repo from the filename.
            if folder == folder_path and key == "sbslib":
                zip_file_name = f"{working_directory}/__lib__/{user}.{folder_path}.{version}.{ext}"
            # sbslibs must keep their package dir at the zip root so they import
            # (zipimport has no namespace packages). A nested sbslib like
            # cosmos_dev would otherwise unzip contents-at-root and fail to
            # import as `cosmos_dev`. mastlib / resource zips stay flat.
            if key == "sbslib":
                zipdir(lib_dir, zip_file_name, folder_path)
            else:
                zipdir(lib_dir, zip_file_name)
            
            
            #print(f"Compressing {lib_dir} into  {zip_file_name}")


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

