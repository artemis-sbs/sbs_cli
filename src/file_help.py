import zipfile
import os
from urllib.request import urlretrieve

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

# # Example Usage:
# zip_file_path = 'my_archive.zip'
# destination_directory = 'extracted_content'
# files_to_exclude = ['secret_data.txt', 'temp_files/', 'log_file.log']

# # Create a dummy zip file for demonstration
# with zipfile.ZipFile(zip_file_path, 'w') as zf:
#     zf.writestr('file1.txt', 'Content of file 1')
#     zf.writestr('secret_data.txt', 'This should not be extracted')
#     zf.writestr('temp_files/temp.log', 'Temporary log')
#     zf.writestr('log_file.log', 'Another log file')
#     zf.writestr('another_dir/another_file.py', 'Python script')

# unzip_exclude(zip_file_path, destination_directory, files_to_exclude)

# Clean up the dummy zip file and extracted directory
# import shutil
# os.remove(zip_file_path)
# shutil.rmtree(destination_directory)


def fetch_deps(dep_libs, is_sbs_lib):
    for dep_lib in dep_libs:
        parts = dep_lib.split(".", 2)
        #print(parts)
        if len(parts) != 3:
            print(f"unsupported dependency format {dep_lib}")
            continue
        user = parts[0]
        repo = parts[1]
        file = parts[2]
        
        version = file.split(".")
        if len(version) < 3:
            print(f"unsupported dependency format {dep_lib}")
            continue
        # remove front
        if not is_sbs_lib:
            version = version[1:]
        # remove end
        version = version[:-1]
        # put back
        version = ".".join(version)
        
        if is_sbs_lib:
            url = f"https://github.com/{user}/{repo}/releases/download/{version}/{user}.{repo}.{file}"
        else:
            url = f"https://github.com/{user}/{repo}/releases/download/{version}/{file}"
        print(f"Fetching {dep_lib} from {url} to __lib__/{dep_lib}")
        os.makedirs("__lib__", exist_ok=True)
        try:
            target = f"__lib__/{dep_lib}"
            urlretrieve(url, target)
        except Exception as e:
            print(f"ERROR: Fetching {dep_lib}\n{e}")

#https://github.com/artemis-sbs/sbs_utils/releases/download/v1.3.0/artemis-sbs.v1.3.0.sbslib 
#https://github.com/artemis-sbs/LegendaryMissions/releases/download/v1.3.0/basic_player_destroy.v1.3.0.mastlib 