
import os
import time

class PurePythonFileWatcher:
    def __init__(self, path_to_watch, max_depth=3, interval=5):
        self.path_to_watch = path_to_watch
        self.interval = interval
        self.max_depth = max_depth
        self.last_state = self._get_current_state()
        
        
    def _get_current_state(self):
        """    Walks a directory tree up to a specified maximum depth.

    Args:
        top_path (str): The path to the top-level directory to start walking from.
        max_depth (int): The maximum depth to traverse (0-indexed).
                         A depth of 0 means only the top_path itself.
                         A depth of 1 includes immediate subdirectories.
    """
   

        current_state = {}
        
        initial_depth = self.path_to_watch.count(os.sep)

        for root, dirs, files in os.walk(self.path_to_watch):
            current_depth = root.count(os.sep) - initial_depth
            if not self.test_root(root):
                continue
            
            if current_depth > self.max_depth:
                # Clear the 'dirs' list to prevent further recursion into subdirectories
                dirs.clear()
                continue # Skip processing files and subdirectories of this level

            for name in files:
                filepath = os.path.join(root, name)
                try:
                    current_state[filepath] = {
                        'mtime': os.path.getmtime(filepath),
                        'size': os.path.getsize(filepath)
                    }
                except FileNotFoundError:
                    # File might have been deleted between os.walk and getmtime
                    pass
        return current_state

    def watch(self):
        while True:
            if self.interval:
                time.sleep(self.interval)
            new_state = self._get_current_state()
            deletions = []
            additions = []
            modified = []

            # Check for deletions
            for filepath in self.last_state:
                if filepath not in new_state:
                    deletions.append(filepath)

            # Check for creations and modifications
            for filepath, new_metadata in new_state.items():
                if filepath not in self.last_state:
                    additions.append(filepath)
                else:
                    old_metadata = self.last_state[filepath]
                    if new_metadata['mtime'] != old_metadata['mtime'] or \
                        new_metadata['size'] != old_metadata['size']:
                        modified.append(filepath)

            self.last_state = new_state
            count = len(deletions) + len(additions) + len(modified)
            return (count, deletions, additions, modified)

    def test_root(self, root):
        return True

