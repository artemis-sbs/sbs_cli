
from cli_cmd import cli, zipapp_dir
# Import needed to properly see commands
from debug_cmd import debug
from overnight_cmd import overnight
from soak_cmd import soak
from web_cmd import web, web_static
from fetch_cmd import fetch
from create_cmd import create, templates
from lib_cmd import lib
from release_cmd import release
from run_cmd import run
from watch_cmd import watch
from compile_cmd import compile
from lint_cmd import lint
from docs_cmd import docs
from deps_cmd import deps
from doctor_cmd import doctor
from fmt_cmd import fmt
from dap_cmd import dap
from swap_cmd import swap
from site_cmd import site
from art_cmd import art
from osc_cmd import osc
from osc_layout_cmd import layout as osc_layout
from osc_web_cmd import web as osc_web
import click


from urllib.request import urlretrieve
from version import VERSION
from file_help import curlretrieve




_RELEASE = "https://github.com/artemis-sbs/sbs_cli/releases/latest/download/"


def update_impl(target):
    """Fetch the newest `sbs.pyz` and `sbs.bat` into `target`. True when it was done.

    A NEW WRITER'S FIRST COMMAND, and it could not fail out loud. It wrote straight over
    the running `sbs.pyz` and printed `Updated sbs` whatever curl had answered - so a
    dropped connection, or an error page from the server, replaced the tool with
    something that was not a tool, said it had worked, and left no way to update again.
    It also wrote into the folder the prompt happened to be in, not the folder the tool
    lives in.

    Each file is fetched under another name, looked at, and only then put in place.
    Everything is imported BEFORE the swap: once `sbs.pyz` is replaced, code still inside
    the old one cannot be loaded.
    """
    import os
    import zipfile
    target = str(target)
    pyz, bat = os.path.join(target, "sbs.pyz"), os.path.join(target, "sbs.bat")
    new_pyz, new_bat = pyz + ".new", bat + ".new"

    def tidy():
        for path in (new_pyz, new_bat):
            try:
                os.remove(path)
            except OSError:
                pass

    if not curlretrieve(_RELEASE + "sbs.pyz", new_pyz) or not zipfile.is_zipfile(new_pyz):
        tidy()
        print("ERROR: the new sbs could not be downloaded. Nothing was changed: the sbs "
              "you have still works. Check the internet connection and type `sbs update` "
              "again.")
        return False
    have_bat = curlretrieve(_RELEASE + "sbs.bat", new_bat)
    if have_bat:
        try:
            with open(new_bat, "r", errors="replace") as f:
                have_bat = "sbs.pyz" in f.read(400)
        except OSError:
            have_bat = False
    try:
        os.replace(new_pyz, pyz)
        if have_bat:
            os.replace(new_bat, bat)
    except OSError as e:
        tidy()
        print(f"ERROR: the new sbs was downloaded but could not be put in {target} ({e}). "
              f"Close anything that is using the folder and type `sbs update` again.")
        return False
    tidy()
    print(f"Updated sbs in {target}. Type `sbs version` to see the new number.")
    return True


@cli.command(short_help="Update the sbs tool.")
def update():
    if not update_impl(zipapp_dir):
        raise SystemExit(1)
    

@cli.command("version")
def version():
    print(f"{VERSION}")
    print(f"{zipapp_dir}")
