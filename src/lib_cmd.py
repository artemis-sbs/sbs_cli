import click
import json
import os

from cli_cmd import cli, zipapp_dir
from file_help import zipdir
from pathlib import Path

def lib_impl(folder, user):
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
        return

# artemis-sbs.sbs_utils.v1.3.0.sbslib
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
            continue
        ext = key
        for folder_path in values:
            lib_dir = deps_file = Path(working_directory).resolve() / folder / folder_path
            zip_file_name = f"{working_directory}/__lib__/{user}.{repo}.{folder_path}.{version}.{ext}"
            # Special can for sbs_utils, because well history
            # sbs libs that match the repo do not include repo
            if folder == folder_path and key == "sbslib":
                zip_file_name = f"{working_directory}/__lib__/{user}.{folder_path}.{version}.{ext}"
            
            zipdir(lib_dir, zip_file_name)
            #print(f"Compressing {lib_dir} into  {zip_file_name}")

@cli.command(short_help="Build libraries/addons.")
@click.argument("folder", default="LegendaryMissions")
@click.option('-su', '--user', default="artemis-sbs", show_default=True, help="Specify The github user/organization.")
def lib(folder, user):
    lib_impl(folder, user)