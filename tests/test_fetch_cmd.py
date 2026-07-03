"""Tests for fetch_cmd -- the issue #1 regression: a bad repo name must NOT
leave a folder behind.

Mocking strategy: ``curlretrieve`` is patched *in the fetch_cmd namespace*
(where it is looked up, per ``from file_help import curlretrieve``), so no real
download happens. ``zipapp_dir`` is redirected to a temp dir and the CWD is set
there too, because fetch cleans/creates folders relative to both.
"""
import _bootstrap  # noqa: F401  (adds ../src to sys.path)

import io
import os
import shutil
import tempfile
import unittest
import zipfile
from unittest import mock

import fetch_cmd


def _fake_curl_writes_zip(url, localname):
    """Stand-in for a successful download: writes a real github-style zip."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Mission-main/story.mast", "== main ==\n")
    with open(localname, "wb") as f:
        f.write(buf.getvalue())
    return True


def _fake_curl_fails(url, localname):
    """Stand-in for a 404: writes nothing, reports failure."""
    return False


def _fake_curl_writes_html(url, localname):
    """Stand-in for the old broken behavior: curl 'succeeds' but the payload
    is a GitHub 404 HTML page, not a zip."""
    with open(localname, "wb") as f:
        f.write(b"<html><body>404 Not Found</body></html>")
    return True


class FetchNoFolderOnBadUrlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self._old_cwd = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(lambda: os.chdir(self._old_cwd))
        # fetch cleans/creates under zipapp_dir; point it at the temp dir.
        self._zip_patch = mock.patch.object(fetch_cmd, "zipapp_dir", self.tmp)
        self._zip_patch.start()
        self.addCleanup(self._zip_patch.stop)

    def _run_fetch(self, repo):
        # skip_libs=True so a successful path never tries to build libraries.
        fetch_cmd.fetch_cmd(
            repo=repo, user="artemis-sbs", branch="main", folder=None,
            overwrite_libs=False, skip_libs=True, skip_clean=False,
            overwrite_sbs_libs=True,
        )

    def test_download_failure_creates_no_folder(self):
        with mock.patch.object(fetch_cmd, "curlretrieve", _fake_curl_fails):
            self._run_fetch("TypoRepo")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "TypoRepo")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "rel.zip")))

    def test_non_zip_payload_creates_no_folder(self):
        with mock.patch.object(fetch_cmd, "curlretrieve", _fake_curl_writes_html):
            self._run_fetch("TypoRepo")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "TypoRepo")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "rel.zip")))

    def test_success_extracts_mission(self):
        with mock.patch.object(fetch_cmd, "curlretrieve", _fake_curl_writes_zip):
            self._run_fetch("Mission")
        story = os.path.join(self.tmp, "Mission", "story.mast")
        self.assertTrue(os.path.isfile(story))
        # download artifact cleaned up
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "rel.zip")))

    def test_cli_bad_url_no_folder(self):
        # Same regression, but through the real Click command (prompt skipped
        # with -q, library build skipped with -sl). No network: curl is mocked.
        from click.testing import CliRunner
        from cli_cmd import cli

        runner = CliRunner()
        with mock.patch.object(fetch_cmd, "curlretrieve", _fake_curl_fails):
            result = runner.invoke(cli, ["fetch", "TypoRepo", "-q", "-sl"])
        self.assertEqual(result.exit_code, 0)
        self.assertIn("BAD MISSION URL", result.output)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "TypoRepo")))


if __name__ == "__main__":
    unittest.main()
