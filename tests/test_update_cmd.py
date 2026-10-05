"""`sbs update` - a new writer's first command.

The game ships an old `sbs` (0.4 in the 1.3.x archives: no `doctor`, no `lint`, no
`create`), so the first thing a course asks of a student is `sbs update`. Found by the
pilot of the lesson "Files, folders and the command prompt":

* it printed `Updated sbs` whatever curl had answered, and wrote straight over the
  running tool - a dropped connection left a file that was not a tool, and no way back;
* it wrote into the folder the prompt was in, not the folder the tool lives in;
* every usage line called the tool `sbs.pyz` to a person who types `sbs`;
* a failed download sitting in `__lib__` (the archive ships one: nine bytes, `Not
  Found`) was picked as the library because its name sorts last.
"""
import os
import tempfile
import unittest
import zipfile
from unittest import mock

from click.testing import CliRunner

import lint_cmd
import main
from cli_cmd import cli


def _a_zip(path):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("__main__.py", "print('new')\n")


class _Install(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = os.path.join(self.tmp.name, "missions")
        os.makedirs(self.home)
        with open(os.path.join(self.home, "sbs.pyz"), "w") as f:
            f.write("the old tool")
        with open(os.path.join(self.home, "sbs.bat"), "w") as f:
            f.write("the old bat")

    def read(self, name):
        with open(os.path.join(self.home, name), "rb") as f:
            return f.read()

    def update(self, fetch):
        with mock.patch.object(main, "curlretrieve", fetch):
            return main.update_impl(self.home)


class AFailedDownloadChangesNothing(_Install):
    def test_curl_failed(self):
        self.assertFalse(self.update(lambda url, name: False))
        self.assertEqual(self.read("sbs.pyz"), b"the old tool")
        self.assertEqual(sorted(os.listdir(self.home)), ["sbs.bat", "sbs.pyz"])

    def test_the_server_sent_a_page_instead_of_the_tool(self):
        def fetch(url, name):
            with open(name, "w") as f:
                f.write("404: Not Found")
            return True
        self.assertFalse(self.update(fetch))
        self.assertEqual(self.read("sbs.pyz"), b"the old tool")
        self.assertEqual(self.read("sbs.bat"), b"the old bat")
        self.assertEqual(sorted(os.listdir(self.home)), ["sbs.bat", "sbs.pyz"])


class AGoodDownload(_Install):
    def fetch(self, url, name):
        if url.endswith(".pyz"):
            _a_zip(name)
        else:
            with open(name, "w") as f:
                f.write('@echo off\n"%~dp0..\\..\\PyRuntime\\python" "%~dp0sbs.pyz" %*\n')
        return True

    def test_both_files_are_replaced_where_the_tool_lives(self):
        elsewhere = tempfile.TemporaryDirectory()
        self.addCleanup(elsewhere.cleanup)
        here = os.getcwd()
        os.chdir(elsewhere.name)
        try:
            self.assertTrue(self.update(self.fetch))
        finally:
            os.chdir(here)
        self.assertTrue(zipfile.is_zipfile(os.path.join(self.home, "sbs.pyz")))
        self.assertIn(b"%~dp0sbs.pyz", self.read("sbs.bat"))
        self.assertEqual(os.listdir(elsewhere.name), [])       # nothing where the prompt was
        self.assertEqual(sorted(os.listdir(self.home)), ["sbs.bat", "sbs.pyz"])

    def test_a_bat_that_did_not_arrive_does_not_stop_the_tool_arriving(self):
        def fetch(url, name):
            return self.fetch(url, name) if url.endswith(".pyz") else False
        self.assertTrue(self.update(fetch))
        self.assertTrue(zipfile.is_zipfile(os.path.join(self.home, "sbs.pyz")))
        self.assertEqual(self.read("sbs.bat"), b"the old bat")


class TheToolIsCalledWhatTheWriterTypes(unittest.TestCase):
    def test_usage_says_sbs(self):
        result = CliRunner().invoke(cli, ["no-such-command"], prog_name=None)
        self.assertIn("Usage: sbs ", result.output)
        self.assertNotIn("sbs.pyz", result.output)


class ALibraryThatIsNotOne(unittest.TestCase):
    def test_a_failed_download_in_lib_is_passed_over(self):
        with tempfile.TemporaryDirectory() as lib:
            real = os.path.join(lib, "artemis-sbs.sbs_utils.v1.4.0.sbslib")
            _a_zip(real)
            with open(os.path.join(lib, "artemis-sbs.sbs_utils.v1.4.0_dev.sbslib"), "w") as f:
                f.write("Not Found")
            self.assertEqual(lint_cmd._sbs_utils_sbslibs(lib), [real])


if __name__ == "__main__":
    unittest.main()
