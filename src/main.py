import click 
import os
from pathlib import Path
import json
from urllib.request import urlretrieve
from file_help import unzip_exclude, fetch_deps

zipapp_dir = Path(__file__).resolve().parent
working_directory = os.curdir

CONTEXT_SETTINGS = dict(help_option_names=['-h', '--help'])

@click.group(context_settings=CONTEXT_SETTINGS)
def cli():
    pass


# @click.argument("repo", default="LegendaryMissions", help="The mission name. i.e. the github repository name")
# @click.option('-u', '--user', default="artemis-sbs", help="Specify The github user/organization. Default artemis-sbs")
# @click.option('-b', '--branch', default="main", help="Specify The github branch/tag. Default main")
# @click.option('-f', '--folder', help="Specify the local folder for mission. Defaults to the same as the repository name.")


@cli.command(short_help="Fetch missions from git repositories.")
@click.argument("repo", default="LegendaryMissions")
@click.option('-u', '--user', default="artemis-sbs", show_default=True, help="Specify The github user/organization.")
@click.option('-b', '--branch', default="main", show_default=True, help="Specify The github branch/tag.")
@click.option('-f', '--folder', help="Specify the local folder for mission. Defaults to the same as the repository name.")
def fetch(repo, user, branch, folder):
    """Fetch command"""
    url = f"https://github.com/{user}/{repo}/zipball/{branch}/"
    zip_file_path = "rel.zip"
    click.echo(f'Fetching {repo} at {url}')

    # These are mostly fo testing
    # skip_repo = True
    # skip_unzip = True
    # skip_remove = True
    skip_repo = False
    skip_unzip = False
    skip_remove = False

    # Retrieve the file from github
    try:
        if not skip_repo:
            urlretrieve(url, zip_file_path)
    except Exception as e:
        print(f"ERROR: BAD MISSION URL: {url}")
        return

    # Unzip to the mission folder
    destination_directory = folder if folder is not None else repo
    files_to_exclude = ['.github/', 'mkdocs/', '.env']
    try:
        if not skip_unzip:
            unzip_exclude(zip_file_path, destination_directory, files_to_exclude)

    except Exception as e:
        print(f"ERROR: Could not unzip: {zip_file_path} {destination_directory}\n{e}")
        return

    # Cleanup downloaded file
    try:
        if not skip_remove:
            os.remove(zip_file_path)
    except Exception as e:
        print(f"ERROR: Could not remove: {zip_file_path} {destination_directory}\n{e}")

    # If we got here we have a folder
    # Get dependencies by processing story.json
    
    deps_file = Path(working_directory).resolve() / destination_directory / "story.json"
    try:
        deps = {}
        
        with open(deps_file, 'r') as f:
            deps = json.load(f)
            # artemis-sbs.sbs_utils.v1.3.0.sbslib
            # Fetch sbs libs
        
        
        #
        # Fetching the sbs_lib dependencies
        #
        sbs_libs = deps.get("sbslib")
        if sbs_libs is not None:
            fetch_deps(sbs_libs, True)
        mast_libs = deps.get("mastlib")
        if mast_libs is not None:
            fetch_deps(mast_libs, False)

        resources = deps.get("resources")
        if resources is not None:
            fetch_deps(resources.values(), False)

        #media
        #  artemis-sbs.LegendaryMissions.media.v1.3.0.zip

    except Exception as e:
        print(f"ERROR: Could not load {deps_file}\n{e}")
    

