"""`sbs lint` - what a writer meets in the first hour.

Found by two lessons written for people who have never used a command prompt. Each of
these was a wrong answer from lint, not from the mission:

* `sbs lint` with no folder name, or `sbs lint .`, linted EVERY mission on the machine
* a mission file renamed, or saved by Notepad as `mission.amd.txt`, was `clean`
* an unclosed quote in `story.mast` was reported against line 1 with the reason lost
* a machine that had never run `sbs debug` was told a clean mission "does not compile"
* `--strict` printed the same bytes as plain lint and failed without saying so
* a UTF-8 file with one curly quote in it could be skipped whole on some machines
"""
import os
import tempfile
import unittest

from click.testing import CliRunner

import lint_cmd
from cli_cmd import cli


class _Folder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mission = os.path.join(self.tmp.name, "MyMission")
        os.makedirs(self.mission)

    def write(self, name, text, encoding="utf-8"):
        path = os.path.join(self.mission, name)
        with open(path, "wb") as f:
            f.write(text.encode(encoding))
        return path


class AFileTheStoryAsksFor(_Folder):
    STORY = ('crew_load_amd("mission.amd")\n'
             '# a note about "notes.amd", which nothing loads\n'
             'doc = document_get_amd_file(get_mission_dir_filename("mission.amd"))\n')

    def missing(self):
        story = self.write("story.mast", self.STORY)
        return lint_cmd._missing_amd_files(self.mission, [story])

    def test_a_file_that_is_there_says_nothing(self):
        self.write("mission.amd", "# [M](m)\n")
        self.assertEqual(self.missing(), [])

    def test_a_renamed_file_is_one_finding_on_the_first_line_that_asks(self):
        self.write("my_mission.amd", "# [M](m)\n")
        found = self.missing()
        self.assertEqual([(rel, line) for rel, line, _ in found], [("story.mast", 1)])
        self.assertIn("`mission.amd`", found[0][2])
        self.assertIn("my_mission.amd", found[0][2])
        self.assertIn("Also asked for on line 3", found[0][2])

    def test_a_file_notepad_saved_with_txt_on_the_end(self):
        self.write("mission.amd.txt", "# [M](m)\n")
        self.assertIn("`mission.amd.txt`", self.missing()[0][2])

    def test_a_name_in_a_sentence_or_an_optional_read_is_not_a_request(self):
        story = self.write("story.mast",
                           'test_expect("loaded", ok, "it must read and register x.amd")\n'
                           'legacy = universe_read_optional_file("side_quests.amd")\n'
                           'name = f"{who}.amd"\n')
        self.assertEqual(lint_cmd._missing_amd_files(self.mission, [story]), [])

    def test_a_file_beside_the_mast_that_names_it_counts(self):
        os.makedirs(os.path.join(self.mission, "addon"))
        self.write(os.path.join("addon", "words.amd"), "# [W](w)\n")
        story = self.write(os.path.join("addon", "addon.mast"), 'x = media_read_relative_file("words.amd")\n')
        self.assertEqual(lint_cmd._missing_amd_files(self.mission, [story]), [])


class ReadingAFile(_Folder):
    TEXT = "# [M](m)\n\nA “ghost ship”.\n"

    def test_every_way_a_writers_editor_saves_it(self):
        for encoding in ("utf-8", "utf-8-sig", "utf-16", "cp1252"):
            with self.subTest(encoding=encoding):
                path = self.write("mission.amd", self.TEXT, encoding)
                self.assertEqual(lint_cmd._read_text(path), self.TEXT)


class WhatTheCompilerSaid(unittest.TestCase):
    def test_an_error_python_raised_is_an_error_too(self):
        for line in ("Error: label is not defined", "Exception: unterminated string literal"):
            with self.subTest(line=line):
                self.assertIsNotNone(lint_cmd._COMPILE_ERROR.match(line))

    def test_a_machine_that_cannot_compile_is_not_a_mission_that_does_not(self):
        import subprocess
        from unittest import mock
        said = ("Missing dev libraries (no sbs_utils source):\n"
                "  artemis-sbs.cosmos_dev.<version>.sbslib\n"
                "Get them from the GitHub release, e.g.:\n")
        done = subprocess.CompletedProcess([], 1, stdout=said, stderr="")
        with tempfile.TemporaryDirectory() as folder:
            app = os.path.join(folder, "sbs.pyz")
            open(app, "w").close()
            with mock.patch.object(lint_cmd.sys, "argv", [app]), \
                    mock.patch.object(subprocess, "run", return_value=done):
                self.assertEqual(lint_cmd._compile_errors("MyMission", folder),
                                 lint_cmd.NOT_CHECKED)


class NoFolderName(_Folder):
    def lint(self, args, cwd):
        here = os.getcwd()
        os.chdir(cwd)
        try:
            return CliRunner().invoke(cli, ["lint"] + args)
        finally:
            os.chdir(here)

    def test_outside_a_mission_it_asks_which_one(self):
        for args in ([], ["."]):
            with self.subTest(args=args):
                result = self.lint(args, self.tmp.name)
                self.assertEqual(result.exit_code, 2)
                self.assertIn("which mission?", result.output)
                self.assertIn("sbs lint MyMission", result.output)


if __name__ == "__main__":
    unittest.main()
