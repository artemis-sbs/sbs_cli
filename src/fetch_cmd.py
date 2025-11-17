import click
import os
import json
import shutil
import pathlib

from cli_cmd import cli, zipapp_dir
from urllib.request import urlretrieve
from file_help import unzip_exclude, fetch_deps
from pathlib import Path
from lib_cmd import lib_impl



def fetch_cmd(repo, user, branch, folder, overwrite_libs, skip_libs, skip_clean, overwrite_sbs_libs):
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
    
    # If we got here we have a folder
    # Get dependencies by processing story.json
    destination_directory = folder if folder is not None else repo
    working_directory = zipapp_dir
    target_directory = Path(working_directory).resolve() / destination_directory 
    depth_check = len(pathlib.Path(target_directory).parents)
    if depth_check < 4:
        print("WARNING: Skipping clean folder depth too shallow")
    elif not skip_clean and os.path.exists(target_directory) and os.path.isdir(target_directory):
        try:
            shutil.rmtree(target_directory)
            #print(f"Directory {depth_check}'{target_directory}' and its contents deleted successfully.")
        except OSError as e:
            print(f"ERROR: Could not remove folder {target_directory} : {e.strerror}")
#    os.makedirs(target_directory, exist_ok=True)


    # Unzip to the mission folder
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

    

   

    deps_file = Path(working_directory).resolve() / destination_directory / "story.json"
    if not os.path.exists(deps_file):
        # its is ok if there is no story.json
        return
    
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
            fetch_deps(sbs_libs, True, overwrite_sbs_libs)
        mast_libs = deps.get("mastlib")
        if mast_libs is not None:
            fetch_deps(mast_libs, False, overwrite_libs)

        resources = deps.get("resources")
        if resources is not None:
            fetch_deps(resources.values(), False, overwrite_libs)

        #media
        #  artemis-sbs.LegendaryMissions.media.v1.3.0.zip

    except Exception as e:
        print(f"ERROR: Could not load {deps_file}\n{e}")
    
    if skip_libs:
        return
    
    try:
        lib_impl(destination_directory, user)
    except Exception as e:
        print("ERROR: error trying to build libraries/addons")

def fetch_repos(repo, user, branch, folder, overwrite_libs, skip_libs, skip_clean, overwrite_sbs_libs):
    """Fetch command"""
    repos = repo.split(",")
    if len(repos)>1 and folder is not None:
        print("ERROR: You cannot set the folder with multiple missions.")
        return
    for repo_item in repos:
        fetch_cmd(repo_item, user, branch, folder, overwrite_libs, skip_libs, skip_clean, overwrite_sbs_libs)


@cli.command(short_help="Fetch missions from git repositories.")
@click.argument("repo", default="LegendaryMissions")
@click.option('-u', '--user', default="artemis-sbs", show_default=True, help="Specify The github user/organization.")
@click.option('-b', '--branch', default="main", show_default=True, help="Specify The github branch/tag.")
@click.option('-f', '--folder', help="Specify the local folder for mission. Defaults to the same as the repository name.")
@click.option('-o', '--overwrite_libs', is_flag=True, help="Force getting libraries from github if they exist local i.e. overwrite the local copy.")
@click.option('-sl', '--skip_libs', is_flag=True, help="This will skip the building of libraries/addons.")
@click.option('-sc', '--skip_clean', is_flag=True, help="This will skip the clearing the target folder.")
@click.option('-q', '--quiet', is_flag=True, help="Suppress the confirm for cleaning directories.")
def fetch(repo, user, branch, folder, overwrite_libs, skip_libs, skip_clean, quiet):
    """Fetch command"""
    if not skip_clean and not quiet:
        click.echo('This will remove the existing folder(s) prior fetching the new version.')
        answer = click.prompt('Continue?', default="N")
        if not (answer[0] == "y" or answer[0] == "Y"):
            return

    fetch_repos(repo, user, branch, folder, overwrite_libs, skip_libs, skip_clean, True)


@cli.command(short_help="Fetch all the missions that ship with Artemis Cosmos from git repositories.")
@click.option('-b', '--branch', default="main", show_default=True, help="Specify The github branch/tag.")
@click.option('-q', '--quiet', is_flag=True, help="Suppress the confirm for cleaning directories.")
def production(branch, quiet):
    """Production command

    branch defaults to 'main' this is the current development.
    using branch 'latest' will get the latest tagged version
    using any other tagged branch will attempt to get the version e.g. 'v1.0.6'
    """
    if not quiet:
        click.echo('This will remove the existing folder(s) prior fetching the new version.')
        answer = click.prompt('Continue?', default="N")
        if not (answer[0] == "y" or answer[0] == "Y"):
            return


    repo  = "LegendaryMissions"
    # This should NO grab the latest sbslib, but rebuild the addons
    fetch_repos(repo, "artemis-sbs", branch, None, True, False, False, True)
    # This should NO grab the latest sbslib or mastlib, etc., but rebuild the addons
    repo = "SecretMeeting,WalkTheLine,remote_mission_pick"
    fetch_repos(repo, "artemis-sbs", branch, None, False, False, False, False)
    # This will ge the common folder
    fetch_repos("sbs_common", "artemis-sbs", branch, "common", False, False, False, False)

    #https://github.com/artemis-sbs/sbs_common/archive/refs/heads/main.zip