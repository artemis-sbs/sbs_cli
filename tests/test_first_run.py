"""A writer's first run, on a machine that is not a developer's.

Found by the pilot of the lesson "Your editor and your first run", on a stand-in built
from the game's own 1.3.7 download:

* the libraries that download ships are months-old builds under TODAY'S names, and
  `sbs create` keeps a library that is already there - so it said `MyMission is ready.`
  and the next three commands each failed with a missing-module error, while `sbs doctor`
  said `0 problems`;
* `sbs fetch --libs` with the internet off took a minute, printed seventy-five lines and
  ended `The mission(s) will NOT run without them`, though nothing had been removed;
* `sbs debug` on a misspelled folder was a traceback;
* `sbs create -t AMD` was refused, and `-title "X"` was read as the template `itle`.
"""
import os
import tempfile
import unittest
import zipfile
from unittest import mock

import click
from click.testing import CliRunner

import create_cmd
import fetch_cmd
import file_help
import lint_cmd
from cli_cmd import cli

SBSLIB = "artemis-sbs.sbs_utils.v1.4.0.sbslib"
MASTLIB = "artemis-sbs.LegendaryMissions.comms.v1.4.0.mastlib"


def _library(path, *modules):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("sbs_utils/__init__.py", "")
        for m in modules:
            z.writestr(f"sbs_utils/procedural/{m}.py", "")


class _Lib(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.lib = self.tmp.name
        self.path = os.path.join(self.lib, SBSLIB)


class IsThisLibraryTooOld(_Lib):
    def test_todays_library_is_not(self):
        _library(self.path, "amd_lint", "amd_lsp")
        self.assertFalse(lint_cmd.sbs_utils_too_old(self.path))

    def test_one_from_before_lint_is(self):
        _library(self.path, "quest")
        self.assertTrue(lint_cmd.sbs_utils_too_old(self.path))

    def test_a_failed_download_is(self):
        with open(self.path, "w") as f:
            f.write("Not Found")
        self.assertTrue(lint_cmd.sbs_utils_too_old(self.path))

    def test_the_error_names_the_command_and_the_mission(self):
        hint = lint_cmd._old_library_hint(ModuleNotFoundError("No module named 'x'"),
                                          os.path.join(self.lib, "My Mission"))
        self.assertIn('sbs fetch "My Mission" --libs', hint)

    def test_another_kind_of_error_gets_no_such_advice(self):
        self.assertEqual(lint_cmd._old_library_hint(ValueError("bad"), "x"), "")


class WhatCreateSaysLast(_Lib):
    deps = {"sbslib": [SBSLIB], "mastlib": [MASTLIB]}
    named = [SBSLIB, MASTLIB]

    def last(self, kept):
        return "\n".join(create_cmd.closing_lines("MyMission", self.deps, self.named,
                                                  kept, self.lib))

    def test_everything_was_fetched(self):
        _library(self.path, "amd_lint", "amd_lsp")
        text = self.last([])
        self.assertIn("MyMission is ready.", text)
        self.assertNotIn("--libs", text)

    def test_libraries_that_were_already_there_are_named_as_kept(self):
        _library(self.path, "amd_lint", "amd_lsp")
        text = self.last([SBSLIB])
        self.assertIn("MyMission is ready.", text)
        self.assertIn("1 of its 2 libraries were already here", text)
        self.assertIn('sbs fetch "MyMission" --libs', text)

    def test_an_old_library_is_not_ready(self):
        _library(self.path, "quest")
        text = self.last([SBSLIB])
        self.assertNotIn("is ready.", text)
        self.assertIn("cannot be checked or run yet", text)
        self.assertIn('sbs fetch "MyMission" --libs', text)


class TemplateNames(unittest.TestCase):
    templates = [{"id": "amd"}, {"id": "ou"}]

    def test_capitals_do_not_matter(self):
        self.assertEqual(create_cmd.choose_template(self.templates, "AMD")["id"], "amd")

    def test_one_dash_on_title_is_explained(self):
        with self.assertRaises(click.ClickException) as raised:
            create_cmd.choose_template(self.templates, "itle")
        self.assertIn("--title", raised.exception.message)


class FetchLibsOffline(unittest.TestCase):
    def test_it_asks_once_and_changes_nothing(self):
        with tempfile.TemporaryDirectory() as missions:
            os.makedirs(os.path.join(missions, "MyMission"))
            with open(os.path.join(missions, "MyMission", "story.json"), "w") as f:
                f.write('{"sbslib": ["%s"]}' % SBSLIB)
            tried = []
            with mock.patch.object(fetch_cmd, "zipapp_dir", missions), \
                    mock.patch.object(fetch_cmd, "_online", lambda: False), \
                    mock.patch.object(file_help, "curlretrieve",
                                      lambda url, name: tried.append(url)):
                result = CliRunner().invoke(cli, ["fetch", "MyMission", "--libs"])
            self.assertEqual(result.exit_code, 1)
            self.assertEqual(tried, [])
            self.assertIn("could not reach github.com", result.output)
            self.assertIn("Nothing was changed", result.output)
            self.assertNotIn("will NOT run", result.output)


class DebugLooksFirst(unittest.TestCase):
    def test_a_misspelled_folder_is_one_line(self):
        with tempfile.TemporaryDirectory() as missions:
            here = os.getcwd()
            os.chdir(missions)
            try:
                result = CliRunner().invoke(cli, ["debug", "MyMision", "--no-gui"])
            finally:
                os.chdir(here)
        self.assertEqual(result.exit_code, 1)
        self.assertIn("not a folder: MyMision", result.output)
        self.assertNotIn("Traceback", result.output)

    def test_a_folder_that_is_not_a_mission(self):
        with tempfile.TemporaryDirectory() as missions:
            os.makedirs(os.path.join(missions, "Notes"))
            here = os.getcwd()
            os.chdir(missions)
            try:
                result = CliRunner().invoke(cli, ["debug", "Notes", "--no-gui"])
            finally:
                os.chdir(here)
        self.assertEqual(result.exit_code, 1)
        self.assertIn("has no story.mast", result.output)


if __name__ == "__main__":
    unittest.main()
