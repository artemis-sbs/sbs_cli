import click
import os
import json
import shutil
import pathlib
import zipfile

from cli_cmd import cli, zipapp_dir
#from urllib.request import urlretrieve
from file_help import unzip_exclude, fetch_deps, curlretrieve
from pathlib import Path
from lib_cmd import lib_impl

# https://github.com/artemis-sbs/LegendaryMissions/archive/refs/heads/main.zip

def is_clone(path):
    """True if `path` is a git working copy. Presence, not cleanliness: a clean clone
    still holds local branches and stashes, so 'it had no changes' is not a licence to
    delete it."""
    return os.path.isdir(os.path.join(path, ".git"))


def fetch_cmd(repo, user, branch, folder, overwrite_libs, skip_libs, skip_clean,
              overwrite_sbs_libs, source=False):
    """Fetch one mission and its dependencies.

    Returns ``(missing_deps, skipped)`` so the caller can end with a truthful exit code:
    a mission whose libraries never arrived, or that was skipped to protect a checkout,
    is not a successful fetch.
    """
    url = f"https://github.com/{user}/{repo}/archive/refs/heads/{branch}.zip"
    zip_file_path = "rel.zip"
    missing_deps = []
    skipped = []

    # These are mostly fo testing
    # skip_repo = True
    # skip_unzip = True
    # skip_remove = True
    skip_repo = False
    skip_unzip = False
    skip_remove = False

    destination_directory = folder if folder is not None else repo
    working_directory = zipapp_dir
    target_directory = Path(working_directory).resolve() / destination_directory
    depth_check = len(pathlib.Path(target_directory).parents)

    # NEVER destroy a checkout. A dev tree keeps its clones at exactly the paths fetch
    # targets, so this would take uncommitted work, stashes and local branches with it,
    # and there is no undo. Skip the repo, keep going, and let the caller exit non-zero -
    # silently skipping would mean "production ran fine" while a mission was not updated.
    # `--skip_clean` unzips OVER the folder instead, which only dirties tracked files and
    # `git checkout .` undoes, so that path only warns.
    if is_clone(target_directory):
        if source:
            print(f"SKIP {repo}: already a clone at {target_directory}")
            print(f"      run `git -C \"{target_directory}\" pull` to update it")
            return missing_deps, [repo]
        if not skip_clean:
            print(f"SKIP {repo}: {target_directory} is a git checkout - refusing to delete it")
            print(f"      move it aside, or `rm -rf \"{target_directory}\"` if you meant to")
            return missing_deps, [repo]
        print(f"WARNING: {repo}: unzipping over the checkout at {target_directory}; "
              f"`git -C \"{target_directory}\" checkout .` restores tracked files")

    if source:
        # export-ignore is applied by `git archive`, which backs the archive URL AND the
        # release source assets - so no archive can carry the stripped folders. Source
        # means a clone.
        clone_url = f"https://github.com/{user}/{repo}.git"
        click.echo(f'Cloning {repo} from {clone_url} ({branch})')
        try:
            import subprocess
            r = subprocess.run(["git", "clone", "--depth", "1", "--branch", branch,
                                clone_url, str(target_directory)],
                               capture_output=True, text=True)
        except FileNotFoundError:
            print("ERROR: --source needs git on PATH")
            return missing_deps, [repo]
        if r.returncode != 0:
            print(f"ERROR: could not clone {repo}\n{(r.stderr or '').strip()}")
            return missing_deps, [repo]
    else:
        click.echo(f'Fetching {repo} at {url}')
        # Retrieve the file from github.
        # Do NOT create/clean any destination folder until we are sure we actually
        # downloaded a real zip -- a typo in the repo name must not leave an empty
        # folder behind (issue #1).
        if not skip_repo:
            ok = False
            try:
                ok = curlretrieve(url, zip_file_path)
            except Exception as e:
                ok = False
            if not ok or not zipfile.is_zipfile(zip_file_path):
                print(f"ERROR: BAD MISSION URL: {url}")
                print(f"       Could not find repository '{repo}' for user '{user}' (branch '{branch}').")
                if os.path.exists(zip_file_path):
                    os.remove(zip_file_path)
                return missing_deps, skipped

        # If we got here we have a valid zip
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
            return missing_deps, skipped

    # Cleanup downloaded file (nothing to remove on the clone path)
    try:
        if not skip_remove and not source and os.path.exists(zip_file_path):
            os.remove(zip_file_path)
    except Exception as e:
        print(f"ERROR: Could not remove: {zip_file_path} {destination_directory}\n{e}")

    

   

    deps_file = Path(working_directory).resolve() / destination_directory / "story.json"
    if not os.path.exists(deps_file):
        # its is ok if there is no story.json
        return missing_deps, skipped
    
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
            missing_deps += fetch_deps(sbs_libs, True, overwrite_sbs_libs)
        mast_libs = deps.get("mastlib")
        if mast_libs is not None:
            missing_deps += fetch_deps(mast_libs, False, overwrite_libs)

        resources = deps.get("resources")
        if resources is not None:
            missing_deps += fetch_deps(resources.values(), False, overwrite_libs)
        # `shared_media` is a dependency too - the difference is only that nobody copies
        # it into the mission. Without this the mission declares a pack that never
        # arrives and its art silently vanishes.
        shared_media = deps.get("shared_media")
        if shared_media:
            missing_deps += fetch_deps(shared_media, False, overwrite_libs)
        if resources is not None or shared_media:
            # ...and unpack the art once, beside the libraries, so a fetched dependency
            # lands in the same layout a locally built one does.
            try:
                from media_cmd import unpack_all
                unpack_all(os.path.join(zipapp_dir, "__lib__"))
            except Exception as e:
                print(f"WARNING: could not unpack media: {e}")

        #media
        #  artemis-sbs.LegendaryMissions.media.v1.3.0.zip

    except Exception as e:
        print(f"ERROR: Could not load {deps_file}\n{e}")
    
    if skip_libs:
        return missing_deps, skipped
    
    try:
        lib_impl(destination_directory, user)
    except Exception as e:
        print("ERROR: error trying to build libraries/addons")
    return missing_deps, skipped


def report_problems(missing, skipped=()):
    """Print what did not happen, and say whether anything did.

    Kept separate so `fetch` and `production` end the same way: a fetch that could not get
    a mission's libraries, or that left a mission alone to protect a checkout, must not
    look like a clean run.
    """
    if not missing and not skipped:
        return False
    if skipped:
        print("\nERROR: these missions were NOT updated (a git checkout is in the way):")
        for name in dict.fromkeys(skipped):
            print(f"  {name}")
    if missing:
        print("\nERROR: these dependencies could not be fetched:")
        for name in dict.fromkeys(missing):      # de-duped, order kept
            print(f"  {name}")
        print("The mission(s) will NOT run without them.")
    return True


def fetch_repos(repo, user, branch, folder, overwrite_libs, skip_libs, skip_clean,
                overwrite_sbs_libs, source=False):
    """Fetch command. Returns (missing dependencies, skipped missions)."""
    repos = repo.split(",")
    if len(repos)>1 and folder is not None:
        print("ERROR: You cannot set the folder with multiple missions.")
        return [], []
    missing, skipped = [], []
    for repo_item in repos:
        # Keep going through the rest of the list on a failure - one unreachable
        # dependency, or one mission protected by its checkout, should not hide the state
        # of the others - and report at the end.
        m, s = fetch_cmd(repo_item, user, branch, folder, overwrite_libs, skip_libs,
                         skip_clean, overwrite_sbs_libs, source)
        missing += m
        skipped += s
    return missing, skipped


@cli.command(short_help="Fetch missions from git repositories.")
@click.argument("repo", default="LegendaryMissions")
@click.option('-u', '--user', default="artemis-sbs", show_default=True, help="Specify The github user/organization.")
@click.option('-b', '--branch', default="main", show_default=True, help="Specify The github branch/tag.")
@click.option('-f', '--folder', help="Specify the local folder for mission. Defaults to the same as the repository name.")
@click.option('-o', '--overwrite_libs', is_flag=True, help="Force getting libraries from github if they exist local i.e. overwrite the local copy.")
@click.option('-sl', '--skip_libs', is_flag=True, help="This will skip the building of libraries/addons.")
@click.option('-sc', '--skip_clean', is_flag=True, help="This will skip the clearing the target folder.")
@click.option('-q', '--quiet', is_flag=True, help="Suppress the confirm for cleaning directories.")
@click.option('--source', is_flag=True,
              help="Clone the repository instead of downloading the archive, so you get "
                   "the addon SOURCE folders a normal fetch leaves out. Needs git.")
def fetch(repo, user, branch, folder, overwrite_libs, skip_libs, skip_clean, quiet, source):
    """Fetch command"""
    if not skip_clean and not quiet:
        click.echo('This will remove the existing folder(s) prior fetching the new version.')
        answer = click.prompt('Continue?', default="N")
        if not (answer[0] == "y" or answer[0] == "Y"):
            return

    missing, skipped = fetch_repos(repo, user, branch, folder, overwrite_libs, skip_libs,
                                   skip_clean, True, source)
    if report_problems(missing, skipped):
        raise SystemExit(1)


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


    missing, skipped = [], []
    repo  = "LegendaryMissions"
    # This should NO grab the latest sbslib, but rebuild the addons
    m, sk = fetch_repos(repo, "artemis-sbs", branch, None, True, False, False, True)
    missing += m; skipped += sk
    # This should NO grab the latest sbslib or mastlib, etc., but rebuild the addons
    repo = "SecretMeeting,WalkTheLine,remote_mission_pick"
    m, sk = fetch_repos(repo, "artemis-sbs", branch, None, False, False, False, False)
    missing += m; skipped += sk
    # Every mission is attempted before this fires, so one bad dependency reports the
    # whole picture instead of aborting the set.
    if report_problems(missing, skipped):
        raise SystemExit(1)
