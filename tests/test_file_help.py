"""Tests for file_help: curlretrieve (mocked subprocess) and unzip_exclude.

No real network / no real curl is invoked -- subprocess.run is mocked, and
unzip_exclude is exercised against an in-memory zip written to a temp dir.
"""
import _bootstrap  # noqa: F401  (adds ../src to sys.path)

import io
import os
import subprocess
import tempfile
import unittest
import zipfile
from unittest import mock

import file_help


class CurlRetrieveTests(unittest.TestCase):
    def test_returns_true_on_success(self):
        fake = mock.Mock(returncode=0, stdout="", stderr="")
        with mock.patch.object(subprocess, "run", return_value=fake) as run:
            ok = file_help.curlretrieve("http://example/x.zip", "out.zip")
        self.assertTrue(ok)
        run.assert_called_once()

    def test_passes_fail_flag(self):
        # -f/--fail is what makes curl exit non-zero on a 404 instead of
        # writing GitHub's HTML error page to disk (issue #1).
        fake = mock.Mock(returncode=0, stdout="", stderr="")
        with mock.patch.object(subprocess, "run", return_value=fake) as run:
            file_help.curlretrieve("http://example/x.zip", "out.zip")
        argv = run.call_args.args[0]
        self.assertIn("-f", argv)

    def test_returns_false_on_http_error(self):
        err = subprocess.CalledProcessError(22, ["curl"], stderr="404")
        with mock.patch.object(subprocess, "run", side_effect=err):
            ok = file_help.curlretrieve("http://example/missing.zip", "out.zip")
        self.assertFalse(ok)

    def test_returns_false_when_curl_missing(self):
        with mock.patch.object(subprocess, "run", side_effect=FileNotFoundError()):
            ok = file_help.curlretrieve("http://example/x.zip", "out.zip")
        self.assertFalse(ok)


def _make_github_archive():
    """Build an in-memory zip shaped like a GitHub archive.

    GitHub wraps everything in a top-level ``<repo>-<branch>/`` folder that
    unzip_exclude is expected to strip.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Repo-main/story.mast", "== main ==\n")
        zf.writestr("Repo-main/media/note.txt", "hi")
        zf.writestr("Repo-main/.github/workflows/ci.yml", "jobs: {}")
    buf.seek(0)
    return buf.read()


class UnzipExcludeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.zip_path = os.path.join(self.tmp, "rel.zip")
        with open(self.zip_path, "wb") as f:
            f.write(_make_github_archive())

    def test_strips_top_folder(self):
        dest = os.path.join(self.tmp, "dest")
        file_help.unzip_exclude(self.zip_path, dest, exclude_files=[])
        # top-level "Repo-main/" is removed: files land directly under dest
        self.assertTrue(os.path.isfile(os.path.join(dest, "story.mast")))
        self.assertTrue(os.path.isfile(os.path.join(dest, "media", "note.txt")))

    def test_honors_excludes(self):
        dest = os.path.join(self.tmp, "dest")
        file_help.unzip_exclude(self.zip_path, dest, exclude_files=[".github/"])
        self.assertFalse(os.path.exists(os.path.join(dest, ".github")))
        self.assertTrue(os.path.isfile(os.path.join(dest, "story.mast")))


if __name__ == "__main__":
    unittest.main()
