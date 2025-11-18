from cli_cmd import cli, zipapp_dir
import click
import time
import os

from file_watcher import PurePythonFileWatcher
from lib_cmd import lib_impl, lib_get_json

class LibWatcher(PurePythonFileWatcher):
    def __init__(self, path_to_watch, max_depth=3, interval=5):
        super().__init__(path_to_watch, max_depth, interval)

    def test_root(self, root):
        return True

class MultiWatch:
    def __init__(self, folders, interval=5):
        _folders = folders
        folders = folders.split(",")
        self.watchers = {}
        self.user = {}
        self.interval = interval
        for folder in folders:
            folder = folder.strip()
            if ":" in folder:
                parts = folder.split(":")
                if len(parts) != 2:
                    print(f"ERROR: Bad folder string {_folders}")
                    self.watchers = {}
                    self.user = {}
                    return
                folder = parts[1]
                self.user[folder] = parts[0]


            if not os.path.exists(folder+"/__lib__.json"):
                print(f"Nothing to watch for in {folder} skipping")
                continue
            # This will handle the interval
            self.watchers[folder] = LibWatcher(folder, interval = 0)


    def watch(self):
        while True:
            if len(self.watchers.keys())==0:
                print("Nothing to watch")
                return
            time.sleep(self.interval)
            for folder, watcher in self.watchers.items():
                count, d,a,m = watcher.watch()
                if count>0:
                    user = self.user.get(folder, "artemis-sbs")
                    print(f"{user}:{folder} changed")
                    lib_impl(folder, user)






@cli.command("watch", short_help="Watch for changes and auto-build libs")
@click.argument("folder")
@click.option("-i", "--interval", default=5)
def watch(folder, interval):
    """Watch
    Watch for changes in things in __lib__.json and build libs on change
    
    """
    watcher = MultiWatch(folder, interval)
    watcher.watch()
