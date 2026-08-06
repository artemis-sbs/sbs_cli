from cli_cmd import cli, zipapp_dir
import click

import subprocess
import time
import ctypes

# `sbs run` drives the Cosmos window, so it is Windows-only - but this module is imported
# by main.py, so touching `ctypes.windll` at import time made the WHOLE tool unusable
# anywhere else. `sbs compile`, `lint` and `create` are plain Python and have every reason
# to run on a Linux CI box. Bind lazily: `run` still fails on a non-Windows host, and only
# `run` does.
if hasattr(ctypes, "windll"):
    from ctypes import wintypes
    MessageBox = ctypes.windll.user32.MessageBoxW
    FindWindow = ctypes.windll.user32.FindWindowW
    SetWindowText = ctypes.windll.user32.SetWindowTextW
    MoveWindow = ctypes.windll.user32.MoveWindow
    GetWindowRect = ctypes.windll.user32.GetWindowRect
    EnumWindows = ctypes.windll.user32.EnumWindows
    GetWindowThreadProcessId = ctypes.windll.user32.GetWindowThreadProcessId
    IsWindowVisible = ctypes.windll.user32.IsWindowVisible
else:
    def _windows_only(*args, **kwargs):
        raise RuntimeError("`sbs run` drives the Cosmos window and needs Windows")
    MessageBox = FindWindow = SetWindowText = _windows_only
    MoveWindow = GetWindowRect = _windows_only
    EnumWindows = GetWindowThreadProcessId = IsWindowVisible = _windows_only


def _window_of(pid, timeout=15.0):
    """The visible top-level window belonging to `pid`, or None.

    Matching by PROCESS beats matching by title. The old code did
    `FindWindow(None, "Engine")` after `time.sleep(1)`, which finds ANY window with that
    title - so launching six instances in a loop raced: a slow start meant renaming the
    wrong window, or None. We own the process handle, so we can ask precisely, and wait
    for the window to appear instead of guessing at a second.
    """
    deadline = time.time() + timeout
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def _cb(hwnd, _lparam):
        wpid = wintypes.DWORD()
        GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value == pid and IsWindowVisible(hwnd):
            found.append(hwnd)
            return False        # stop enumerating
        return True

    while time.time() < deadline:
        found.clear()
        EnumWindows(_cb, 0)
        if found:
            return found[0]
        time.sleep(0.25)
    return None



@cli.command("run")
@click.argument("consoles", default="")
@click.argument("extra", nargs=-1)
@click.option("--mission", "-m", default="LegendaryMissions", show_default=True,
              help="Mission folder the server boots. Passed as defaultmission=, so "
                   "preferences.json is left alone.")
@click.option("--ip", default="127.0.0.1", show_default=True,
              help="Server address the clients auto-connect to.")
@click.option("--no-auto", is_flag=True,
              help="Launch without autostart, so every window shows the launcher menu "
                   "(the behavior before engine 1.3.5 made autostart possible).")
@click.option("--dry-run", is_flag=True,
              help="Print the command line each window would get, and launch nothing.")
def run(consoles, extra, mission, ip, no_auto, dry_run):
    """Launch a server and a set of console clients.

        sbs run                                  server + the five standard consoles
        sbs run comms,weapons                    just those two
        sbs run comms map=sandbox profile=soak   pass anything else straight through
        sbs run --dry-run                        show the command lines, launch nothing

    The mission comes from `--mission` rather than whatever `preferences.json` happens to
    hold - a launch should say what it is launching, and mutating a shared preferences file
    to choose one is the same shared-global problem `console=` just removed.

    EXTRA arguments are appended to every window verbatim. Engine 1.3.5 passes unrecognized
    `key=value` arguments through to `command_line_dict()`, so a mission reads whatever it
    likes without the engine or this tool knowing the name - `map=`, `profile=`, `var.X=`,
    `seed=`, `record=`, `test=` all work with no change here.

    Autostart makes the whole thing clickless: the server window gets `autostartserver`,
    each client gets `autostartclient` plus `clientautoconnectip=` and its `console=`. Pass
    `--no-auto` for the old launcher-menu behavior.
    """
    
    #
    # get mission from args
    # update setup.json
    # starts sevrer and clients
    import os 
    missions = os.path.dirname(os.path.realpath(__file__))
    if os.path.basename(missions)!="missions":
        missions = os.path.dirname(missions)
    data_path = os.path.dirname(missions)
    cosmos_path = os.path.dirname(data_path)
    os.chdir(cosmos_path)
    #
    #
    #
    # NOTE: `client_string_set.txt` is no longer touched. Selecting a console used to mean
    # rewriting that file inside the game install before each launch and restoring it after
    # the loop - a shared global configuring a per-process choice, so two concurrent runs
    # corrupted each other, and an exception mid-loop left the user's file holding a single
    # console name (the restore had no try/finally). `console=` on the command line is
    # per-process: nothing shared, nothing to restore, nothing to clean up after a crash.
    # Handled by LegendaryMissions' common_console_select.mast.
    #
    if consoles is None or consoles == "":
        windows = ["Server", "comms", "weapons", "science", "engineering", "cinematic" ] 
    else:
        windows = consoles.split(",")
    # Naming consoles explicitly drops the server, and autostart makes that worse than it
    # used to be: the clients now come up connecting to a machine that is not serving,
    # rather than sitting harmlessly at the launcher menu. Say so - it is the same class of
    # quiet failure as a launch argument that matches nothing.
    # Only check when `missions` really is the missions folder. Run from a build or test
    # directory the path walk above lands somewhere else, and a warning that fires wrongly
    # is worse than none - it trains people to ignore it.
    # `__lib__` is not the marker - sbs_cli has one of its own, so the first attempt at
    # this warned about a perfectly good mission. The folder NAME is the actual test, and
    # it is the same condition the path walk above already relies on.
    looks_like_missions = os.path.basename(missions).lower() == "missions"
    if mission and looks_like_missions and not os.path.isdir(os.path.join(missions, mission)):
        print(f"  note: mission folder '{mission}' not found in {missions} - "
              "the server will not find it either")

    if not no_auto and ip in ("127.0.0.1", "localhost"):
        if not any(w.strip().lower() == "server" for w in windows):
            print("  note: no 'Server' in the list, so nothing is serving on "
                  f"{ip} - add Server, pass --ip, or use --no-auto")

    x = 0
    y = 0
    c = 0
    for w in windows:
        is_server = w.strip().lower() == "server"
        args = ["Artemis3-x64-release.exe"]
        if not no_auto:
            # Clickless. The server is launched first (it heads the list), so by the time a
            # client tries to connect the server window has already been waited for below.
            if is_server:
                args.append("autostartserver")
            else:
                args += ["autostartclient", f"clientautoconnectip={ip}"]
        if is_server:
            # Only the server boots a mission; a client gets it from the server once
            # connected, so passing it there would be noise.
            if mission:
                args.append(f"defaultmission={mission}")
        else:
            # "Server" is not a console; it reaches the mission picker either way.
            args.append(f"console={w}")
        args += list(extra)

        if dry_run:
            print(f"  {w:14} {' '.join(args)}")
            continue
        proc = subprocess.Popen(args)

        hwnd = _window_of(proc.pid)
        if hwnd is None:
            print(f"  {w}: no window appeared - leaving it untitled and unplaced")
            continue
        SetWindowText(hwnd, w)
        rect = wintypes.RECT()
        hr = GetWindowRect(hwnd, ctypes.pointer(rect))
        MoveWindow(hwnd, x, y, rect.right-rect.left, rect.bottom-rect.top, False)
        x += rect.right-rect.left + 50
        if c%2:
            y += (rect.bottom-rect.top) // 3
            x = 0
        c+=1

# subprocess.Popen(["Artemis3-x64-release.exe"]) ###, "your", "arguments", "comma", "separated"])
