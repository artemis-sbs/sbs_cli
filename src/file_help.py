import zipfile
import os
# from urllib.request import urlretrieve

#https://github.com/DizzyKungFu/Lucky_13/archive/refs/heads/main.zip
#https://github.com/DizzyKungFu/Lucky_13/archive/refs/heads/main.zip
#https://github.com/DizzyKungFu/Lucky_13/archive/refs/heads/main.zip
###curl
# "https://github.com/%USER%/%REPO%/zipball/%BRANCH%/"

def curlretrieve(url, localname):
    """Use curl to retrieve the files

    Args:
        url (str): the url
        localname (str): The local filename

    Returns:
        bool: True if the file was downloaded successfully, False otherwise.
    """
    import subprocess

    # Recommended way to run a command and capture output
    try:
        # -f/--fail makes curl exit non-zero on HTTP errors (e.g. 404) instead
        # of quietly writing the error page (like GitHub's 404 HTML) to disk.
        result = subprocess.run(
            ["curl", "-f", "-L", "--max-redirs", "5", f"{url}", "--output", localname],  # Command and arguments as a list
            capture_output=True,   # Capture stdout and stderr
            text=True,             # Return strings instead of bytes
            check=True             # Raise exception on non-zero exit
        )
        print("Command ran successfully.")
        print(result.stdout)
        return True
    except subprocess.CalledProcessError as e:
        print(f"Command failed with return code {e.returncode}")
        print(e.stderr)
        return False
    except FileNotFoundError:
        print("Command not found.")
        return False


def zipdir(folder_path, zip_file_name, first_folder=None):
    
    skips =  {"__pycache__"}
    #
    with zipfile.ZipFile(zip_file_name, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=8) as zf:
        for root, subdirs, files in os.walk(folder_path):
            s = False
            for skip in skips:
                if skip in root:
                    s = True
            if s:
                continue

            for file in files:
                file_path = os.path.join(root, file)

                archive_path = str(os.path.relpath(file_path, folder_path))

                if first_folder is not None:
                    archive_path = f"{first_folder}\\{archive_path}"
                zf.write(file_path, archive_path)



def unzip_exclude(zip_path, extract_dir, exclude_files=None):
    """
    Unzips a file, excluding specified files from extraction.

    Args:
        zip_path (str): The path to the zip file.
        extract_dir (str): The directory where files should be extracted.
        exclude_files (list, optional): A list of filenames (or patterns) to exclude.
                                        Defaults to None, meaning no files are excluded.
    """
    if exclude_files is None:
        exclude_files = []

    os.makedirs(extract_dir, exist_ok=True)
    #
    # This unzips removing the github folder
    #
    with zipfile.ZipFile(zip_path, 'r') as zf:
        for member in zf.infolist():
            parts = member.filename.split('/')
            # Check if the member should be excluded
            if any(exclude_pattern in member.filename for exclude_pattern in exclude_files):
                #print(f"Skipping excluded file: {member}")
                continue

            # Extract the member if it's not excluded
            # Handle directories separately to ensure they are created
            # If there's a top-level directory and it's not a directory entry itself
            if len(parts) > 1 and not member.filename.endswith('/'):
                # Reconstruct the filename, skipping the first part
                new_filename = os.sep.join(parts[1:])
                
                # Only proceed if there's a valid new filename (not just an empty string)
                if new_filename:
                    # Create the full path for the extracted file
                    target_path = os.path.join(extract_dir, new_filename)
                    
                    # Create parent directories if they don't exist
                    os.makedirs(os.path.dirname(target_path), exist_ok=True)
                    
                    # Extract the file with the modified name
                    with open(target_path, 'wb') as f:
                        f.write(zf.read(member.filename))
            elif not member.filename.endswith('/'): # Handle files directly in the root of the zip
                target_path = os.path.join(extract_dir, member.filename)
                os.makedirs(os.path.dirname(target_path), exist_ok=True)
                with open(target_path, 'wb') as f:
                    f.write(zf.read(member.filename))



def release_asset_candidates(local_name):
    """The names to try on a GitHub release for a lib whose LOCAL name is `local_name`.

    A lib is stored in `__lib__/` (and referenced from story.json) as
    `{user}.{repo}.{folder}.{version}.{ext}`, but repos do not all PUBLISH it under that
    name. sbs_utils' workflow interpolates owner+repo, so its sbslib asset matches the
    local name; LegendaryMissions' workflow interpolates only the bare folder, so
    `artemis-sbs.LegendaryMissions.hangar.v1.4.0.mastlib` is published as
    `hangar.v1.4.0.mastlib`. Both conventions are live and neither is going away.

    Returns a LIST, most likely first, so a caller can fall back rather than 404 and give
    up: the two repos already disagree and either could change, and the fallback costs one
    extra request only when the first name misses.

    Args:
        local_name (str): The lib's filename as stored in `__lib__/`.

    Returns:
        list[str]: Asset names to try, or `[local_name]` if the name cannot be parsed.
    """
    if local_name.endswith(".sbslib"):
        # {user}.{package}.{version}.sbslib - only TWO segments precede the version, and
        # the asset is published under exactly this name. Stripping them would leave a
        # bare "v1.4.0.sbslib", so there is no meaningful alternative to offer.
        return [local_name]
    parts = local_name.split(".", 2)          # {user}.{repo}.{folder}.{version}.{ext}
    if len(parts) != 3:
        return [local_name]
    # Canonical name first: the repo now publishes mastlibs under the same name they are
    # stored as. The bare `{folder}.{version}.{ext}` form is what LegendaryMissions used
    # to publish, kept as a fallback so an older tag still resolves.
    return [local_name, parts[2]]


def fetch_deps(dep_libs, is_sbs_lib, overwrite_libs):
    """ This will fetch the dependencies from a github release

    Args:
        dep_libs ([str]]): The list of dependencies
        is_sbs_lib (bool): If this is a list of sbslibs they have different naming conventions
    """
    for dep_lib in dep_libs:
        parts = dep_lib.split(".", 2)
        #print(parts)
        if len(parts) != 3:
            print(f"ERROR: unsupported dependency format {dep_lib}")
            continue
        user = parts[0]
        repo = parts[1]
        file = parts[2]
        
        version = file.split(".")
        if len(version) < 3:
            print(f"ERROR: unsupported dependency format {dep_lib}")
            continue
        # remove front
        if not is_sbs_lib:
            version = version[1:]
        # remove end
        version = version[:-1]
        # put back
        version = ".".join(version)

        target = f"__lib__/{dep_lib}"
        if not overwrite_libs and os.path.exists(target):
            #print("SKIPPING")
            continue
        
        os.makedirs("__lib__", exist_ok=True)
        base = f"https://github.com/{user}/{repo}/releases/download/{version}"
        # Stage through a temp file: `curl -f` still CREATES the output file on a 404, and
        # an empty lib left at `target` is silently skipped by the exists() check above on
        # the next run - a corrupt lib that looks fetched.
        tmp = target + ".download"
        errors = []
        for asset in release_asset_candidates(dep_lib):
            url = f"{base}/{asset}"
            print(f"Fetching {dep_lib} from {url} to {target}")
            try:
                curlretrieve(url, tmp)
            except Exception as e:
                errors.append(f"{asset}: {e}")
                continue
            if os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
                os.replace(tmp, target)
                break
            errors.append(f"{asset}: empty response")
        else:
            for e in errors:
                print(f"ERROR: Fetching {dep_lib}\n{e}")
        if os.path.exists(tmp):
            os.remove(tmp)

#https://github.com/artemis-sbs/sbs_utils/releases/download/v1.3.0/artemis-sbs.v1.3.0.sbslib 
#https://github.com/artemis-sbs/LegendaryMissions/releases/download/v1.3.0/basic_player_destroy.v1.3.0.mastlib 