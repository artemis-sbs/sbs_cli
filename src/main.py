
from cli_cmd import cli, zipapp_dir
# Import needed to properly see commands
from debug_cmd import debug
from overnight_cmd import overnight
from web_cmd import web, web_static
from fetch_cmd import fetch
from lib_cmd import lib
from release_cmd import release
from run_cmd import run
from watch_cmd import watch
from compile_cmd import compile
import click


from urllib.request import urlretrieve
from version import VERSION
from file_help import curlretrieve




@cli.command(short_help="Update the sbs tool.")
def update():
    try:
        url = "https://github.com/artemis-sbs/sbs_cli/releases/latest/download/sbs.bat"
        curlretrieve(url, "sbs.bat")
        url = "https://github.com/artemis-sbs/sbs_cli/releases/latest/download/sbs.pyz"
        curlretrieve(url, "sbs.pyz")
        # Note: You can't do much after this
        # since it updated the running zip file
        # so you can no longer call code in the zip
        print("Updated sbs")
    except Exception as e:
        print(f"ERROR: BAD MISSION URL: {url}\n{e}")
        return
    

@cli.command("version")
def version():
    print(f"{VERSION}")
    print(f"{zipapp_dir}")
