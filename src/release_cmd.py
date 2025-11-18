from pathlib import Path
import click
import subprocess

from cli_cmd import cli, zipapp_dir
from lib_cmd import lib_get_json
# Import needed to properly see commands

def run_cmd(cmd, target_directory=None):
    try:
        result = subprocess.run(cmd, cwd=target_directory, capture_output=True, text=True, check=True)
        print("Standard Output:", result.stdout)
        print("Standard Error:", result.stderr)
        print("Return Code:", result.returncode)

    except Exception as e:
        raise

    return True

@cli.command("release")
@click.argument('folder', required=True)
@click.argument('message', required=False)
@click.option('-v', '--version')
@click.option('-u', '--unrelease', is_flag=True)
def release(folder,  message, version, unrelease):
    working_directory = zipapp_dir
    target_directory = str(Path(working_directory).resolve() / folder)

    libs = lib_get_json(folder)
    version = libs.get("version")
    if version is None:
        print(f"ERROR: version is needed in __lib__.json to build libraries ")
        return

    if unrelease:
        run_cmd(f"git tag --delete {version}", target_directory)
        run_cmd(f"git push --delete origin {version}", target_directory)

    if message is not None:
        # git tag -a %VERSION% -m %2
        run_cmd(f"git tag -a {version} -m \"{message}\"", target_directory)
        # git push --tags
        run_cmd(f"git push --tags", target_directory)

