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
def run(consoles):
    
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
    x = 0
    y = 0
    c = 0
    for w in windows:
        # "Server" is not a console, so it launches unmodified and reaches the picker as it
        # always did. Everything else names its console on the command line.
        args = ["Artemis3-x64-release.exe"]
        if w.strip().lower() != "server":
            args.append(f"console={w}")
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
