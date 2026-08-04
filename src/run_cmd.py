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
else:
    def _windows_only(*args, **kwargs):
        raise RuntimeError("`sbs run` drives the Cosmos window and needs Windows")
    MessageBox = FindWindow = SetWindowText = _windows_only
    MoveWindow = GetWindowRect = _windows_only



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
    client_strings = os.path.join(data_path, "client_string_set.txt")
    f = open(client_strings, "r")
    cl_contents =f.read()
    f.close()
    #
    if consoles is None or consoles == "":
        windows = ["Server", "comms", "weapons", "science", "engineering", "cinematic" ] 
    else:
        windows = consoles.split(",")
    x = 0
    y = 0
    c = 0
    for w in windows:
        f = open(client_strings, "w")
        f.write(f"""console_previous
    {w}
    """)
        f.close()
        #time.sleep(0.1)
        subprocess.Popen(["Artemis3-x64-release.exe"]) ###, "your", "arguments", "comma", "separated"])
        time.sleep(1)
        hwnd = FindWindow(None, "Engine")
        SetWindowText(hwnd, w)
        rect = wintypes.RECT()
        hr = GetWindowRect(hwnd, ctypes.pointer(rect))
        MoveWindow(hwnd, x, y, rect.right-rect.left, rect.bottom-rect.top, False)
        x += rect.right-rect.left + 50
        if c%2:
            y += (rect.bottom-rect.top) // 3
            x = 0
        c+=1
        
    f = open(client_strings, "w")
    f.write(cl_contents)

# subprocess.Popen(["Artemis3-x64-release.exe"]) ###, "your", "arguments", "comma", "separated"])
