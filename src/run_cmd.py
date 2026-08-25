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



def _seeded_client_strings(name):
    """EXACTLY what the batch file wrote: one key/value pair and nothing else.

    Deliberately not a merge. The real file is a list of alternating key/value LINES and a
    live one starts with an EMPTY pair, then console_mode, then console_previous - a shape
    auto_run.py never produced, because it replaced the whole file. Preserving the other
    keys was an improvement nobody asked for, and it changes what the engine parses at the
    one moment that matters. The original is restored in the `finally` below, so nothing is
    actually lost by writing over them.

    The Server window gets one too, exactly as the batch file did.
    """
    return "console_previous" + "\n" + ("" if name is None else name) + "\n"


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
@click.option("--settle", default=2.0, show_default=True, metavar="SECONDS",
              help="Minimum wait after launching a window before the NEXT one is seeded. "
                   "The console each client opens on travels through a single shared file, "
                   "so seeding the next window too early takes it away from the one still "
                   "reading. Raise it if windows come up on the wrong console.")
def run(consoles, extra, mission, ip, no_auto, dry_run, settle):
    """Launch a server and a set of console clients.

        sbs run                                  server + the five standard consoles
        sbs run comms,weapons                    just those two
        sbs run comms map=sandbox profile=soak   pass anything else straight through
        sbs run --dry-run                        show the command lines, launch nothing

    The mission comes from `--mission` rather than whatever `preferences.json` happens to
    hold - a launch should say what it is launching rather than mutate a shared file to
    say it.

    EXTRA arguments are appended to every window verbatim. Engine 1.3.5 passes unrecognized
    `key=value` arguments through to `command_line_dict()`, so a mission reads whatever it
    likes without the engine or this tool knowing the name - `map=`, `profile=`, `var.X=`,
    `seed=`, `record=`, `test=` all work with no change here.

    Autostart makes the whole thing clickless: the server window gets `autostartserver`,
    each client gets `autostartclient` plus `clientautoconnectip=`. The console each client
    opens on is seeded through `client_string_set.txt` (see the note below - it cannot be a
    command-line argument). Pass `--no-auto` for the old launcher-menu behavior.
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
    # LAUNCH BY ABSOLUTE PATH, not by bare name. The chdir above is still needed - the
    # engine resolves its own data relative to the working directory - but it is NOT enough
    # to FIND the exe. CreateProcess only searches the current directory when
    # `NoDefaultCurrentDirectoryInExePath` is unset, and MSYS2/Git-Bash exports it, so a bare
    # "Artemis3-x64-release.exe" died with WinError 2 for anyone launching from Git Bash (or
    # any terminal descended from one) while working perfectly from cmd.
    exe = os.path.join(cosmos_path, "Artemis3-x64-release.exe")
    if not os.path.isfile(exe):
        raise click.ClickException(f"engine not found: {exe}")
    #
    #
    #
    # HOW A CONSOLE IS SELECTED, and why it is this awkward.
    #
    # `console=<name>` on the client's command line was tried and REVERTED. It cannot work:
    # the mission script runs on the SERVER, and `sbs.command_line_dict()` is the server's
    # own command line, so an argument handed to a client exe is invisible to the script
    # that would have to act on it. The engine's only per-client channel is
    # `request_client_string`, which literally "requests a string value from the client
    # computer" - and a client's strings are seeded from `client_string_set.txt` in the
    # game install before it starts.
    #
    # That file is a shared global being used to configure a per-process choice, which is
    # genuinely bad: two concurrent `sbs run`s corrupt each other. What is fixed here is
    # the part that was actually losing people's data - the restore now runs in a
    # `finally`, so a crash or a Ctrl-C mid-loop can no longer leave the file holding one
    # console name. Concurrency is not fixable from this side; it needs the engine to seed
    # a client string from the client's own launch argument.
    #
    # `console_previous` is the key, and writing it is the whole point: this is what
    # commit 593a543 removed, believing `console=` replaced it. It did not - `console=`
    # reaches only the CLIENT process, and the mission script runs on the SERVER, so the
    # mission never saw it. With nothing seeding the file, each client fell back to the
    # console the engine had persisted from the PREVIOUS session, which is the one-run lag
    # that was reported ("science started as helm, comms started as science").
    #
    # console_mode was tried instead and is worse: it routes the client through
    # console_force_mode, a holding screen whose only exit is the server reroute, and on an
    # in-game restart the console never appeared at all.
    #
    client_strings = os.path.join(data_path, "client_string_set.txt")
    try:
        with open(client_strings, encoding="utf-8") as f:
            saved_client_strings = f.read()
    except OSError:
        saved_client_strings = None

    def _seed_console(name):
        """Point the NEXT client at `name`; blank for the server."""
        if saved_client_strings is None:
            return
        with open(client_strings, "w", encoding="utf-8") as f:
            f.write(_seeded_client_strings(name))

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

    # try/finally, and this is the whole reason the file is safe to touch again: the
    # old version restored AFTER the loop with nothing guarding it, so any exception -
    # or a Ctrl-C while waiting on a window - left the user's client_string_set.txt
    # holding one console name, permanently forcing that console on every later launch.
    try:
        x = 0
        y = 0
        c = 0
        for w in windows:
            is_server = w.strip().lower() == "server"
            args = [exe]
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
            args += list(extra)

            if dry_run:
                print(f"  {w:14} {' '.join(args)}")
                continue
            # Seed IMMEDIATELY before the launch, and do not touch the file again until this
            # process has a window - the engine reads it during start-up, so overwriting it for
            # the next window too early hands two clients the same console.
            # WRITE, LAUNCH, THEN WAIT - and the wait is the part that matters. The
            # engine reads client_string_set.txt during start-up, and this file is a
            # shared global: the moment the next window is seeded, whatever the
            # previous one had not yet read is gone. auto_run.py got this right with a
            # flat `time.sleep(1)` after every Popen.
            #
            # Waiting for the WINDOW is not the same thing, and that was the
            # regression: a window appears well before start-up finishes, so the next
            # seed landed while the client was still reading - which is exactly the
            # shifted assignment that was reported (the science window opening on Helm,
            # the comms window on Science). Worse, when no window appeared the code
            # `continue`d and skipped the wait altogether.
            #
            # So: measure from the LAUNCH, wait for the window too (a better signal
            # when it arrives), and never skip the settle. --settle tunes it.
            launched_at = time.time()
            _seed_console(None if is_server else w.strip())
            proc = subprocess.Popen(args)

            hwnd = _window_of(proc.pid)
            remaining = settle - (time.time() - launched_at)
            if remaining > 0:
                time.sleep(remaining)
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
    finally:
        # Always put the user's file back, even on Ctrl-C. Nothing else in this command
        # is worth leaving the game install modified for.
        if saved_client_strings is not None:
            try:
                with open(client_strings, "w", encoding="utf-8") as f:
                    f.write(saved_client_strings)
            except OSError as e:
                print(f"  WARNING: could not restore {client_strings}: {e}")

# subprocess.Popen(["Artemis3-x64-release.exe"]) ###, "your", "arguments", "comma", "separated"])
