"""`sbs doctor` - a report, and only a report.

The load-bearing test here is `test_doctor_never_reads_content`. Doctor's scope
line - *it answers "is this set up correctly", never "is this content correct"* -
is the kind of rule that erodes one helpful addition at a time until doctor is a
second, slower linter that disagrees with the first. Asserting it mechanically is
what keeps it true.
"""
import builtins
import json
import os
import subprocess
import tempfile
import unittest
from unittest import mock

from click.testing import CliRunner

import doctor_cmd
from cli_cmd import cli

_REAL_MISSIONS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _with_sbs_utils(case):
    """Make the real sbs_utils importable.

    Doctor flags an un-importable sbs_utils, correctly - so a fixture without one
    is not a "clean" tree, it is a broken one. Every real machine has it."""
    import sys
    if not os.path.isdir(os.path.join(_REAL_MISSIONS, "sbs_utils")):
        case.skipTest("sbs_utils working tree not beside sbs_cli")
    # The REPO folder, not the missions folder: `missions/sbs_utils/` has no
    # `__init__.py`, so putting `missions/` on the path imports it as a
    # namespace package with `__file__ = None`. The package is one level in.
    repo = os.path.join(_REAL_MISSIONS, "sbs_utils")
    if repo not in sys.path:
        sys.path.insert(0, repo)
        case.addCleanup(sys.path.remove, repo)


def _cosmos(root):
    """A Cosmos-shaped tree: PyRuntime, data/graphics, data/missions, __lib__."""
    os.makedirs(os.path.join(root, "PyRuntime"), exist_ok=True)
    os.makedirs(os.path.join(root, "data", "graphics"), exist_ok=True)
    missions = os.path.join(root, "data", "missions")
    os.makedirs(os.path.join(missions, "__lib__"), exist_ok=True)
    return missions


def _mission(missions, name="Demo", story=None, amd=True):
    path = os.path.join(missions, name)
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "story.json"), "w") as f:
        json.dump(story if story is not None else {"sbslib": [], "mastlib": []}, f)
    if amd:
        with open(os.path.join(path, "x.amd"), "w") as f:
            f.write("# [A](a)\nbody\n")
        with open(os.path.join(path, "story.mast"), "w") as f:
            f.write("== main ==\n")
    return path


class DoctorTests(unittest.TestCase):
    def setUp(self):
        _with_sbs_utils(self)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.missions = _cosmos(self.tmp.name)
        self._md = mock.patch.object(doctor_cmd, "_missions_dir",
                                     lambda: self.missions)
        self._md.start()
        self.addCleanup(self._md.stop)
        # No real tools are probed.
        self._tool = mock.patch.object(subprocess, "run",
                                       side_effect=FileNotFoundError())
        self._tool.start()
        self.addCleanup(self._tool.stop)
        self.runner = CliRunner()

    def run_doctor(self, *args):
        return self.runner.invoke(cli, ["doctor", *args])

    def test_a_clean_mission_has_no_problems(self):
        _mission(self.missions)
        res = self.run_doctor()
        self.assertEqual(res.exit_code, 0)
        self.assertNotIn("!!", res.output)

    def test_it_exits_zero_even_with_problems(self):
        # A report that fails the build is a linter.
        _mission(self.missions, story={"sbslib": ["gone.sbslib"]})
        res = self.run_doctor()
        self.assertEqual(res.exit_code, 0)
        self.assertIn("!!", res.output)

    def test_strict_turns_a_problem_into_an_exit_code(self):
        _mission(self.missions, story={"sbslib": ["gone.sbslib"]})
        self.assertEqual(self.run_doctor("--strict").exit_code, 1)

    def test_strict_is_still_zero_with_nothing_to_flag(self):
        _mission(self.missions)
        self.assertEqual(self.run_doctor("--strict").exit_code, 0)

    def test_a_declared_library_that_is_missing_is_named_with_a_remedy(self):
        _mission(self.missions, story={"sbslib": ["artemis-sbs.thing.v1.sbslib"]})
        res = self.run_doctor()
        self.assertIn("artemis-sbs.thing.v1.sbslib", res.output)
        self.assertIn("sbs fetch", res.output)

    def test_unparseable_story_json_is_a_problem(self):
        path = _mission(self.missions)
        with open(os.path.join(path, "story.json"), "w") as f:
            f.write("{not json")
        res = self.run_doctor()
        self.assertIn("will not parse", res.output)

    def test_generated_shipdata_is_flagged(self):
        # The library reads it back AND the addon merges the same entries again,
        # so hull counts double from the second run onward. Outside a repo the
        # tell is the `.bak` - nobody hand-authors one of those.
        path = _mission(self.missions)
        for f in ("extraShipData.json", "extraShipData.json.bak"):
            with open(os.path.join(path, f), "w") as fh:
                fh.write("{}")
        res = self.run_doctor()
        self.assertIn("extraShipData.json", res.output)
        self.assertIn("!!", res.output)

    def test_an_authored_shipdata_file_is_left_alone(self):
        # LM_TestRange COMMITS one because its engine probe exists to test whether
        # the engine re-reads that very file; VisualTestRange commits one to
        # reproduce an art bug. Telling people to delete the instrument is worse
        # than saying nothing.
        path = _mission(self.missions)
        with open(os.path.join(path, "extraShipData.json"), "w") as f:
            f.write("{}")
        res = self.run_doctor()
        self.assertNotIn("!!  shipdata", res.output)

    def test_it_says_where_to_go_for_content_checks(self):
        _mission(self.missions)
        res = self.run_doctor()
        self.assertIn("sbs lint", res.output)
        self.assertIn("sbs compile", res.output)

    def test_json_output_is_a_flat_record_list(self):
        _mission(self.missions)
        res = self.run_doctor("--json")
        data = json.loads(res.output)
        self.assertIn("checks", data)
        self.assertTrue(data["checks"])
        for row in data["checks"]:
            self.assertIn(row["status"], ("ok", "--", "!!"))
            self.assertIn("section", row)

    def test_env_only_skips_missions(self):
        _mission(self.missions, name="Demo")
        res = self.run_doctor("--env")
        self.assertNotIn("Demo", res.output)
        self.assertIn("Python", res.output)


class ScopeTests(unittest.TestCase):
    """Doctor is set-up, never content."""

    def setUp(self):
        _with_sbs_utils(self)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.missions = _cosmos(self.tmp.name)
        _mission(self.missions)
        self._md = mock.patch.object(doctor_cmd, "_missions_dir",
                                     lambda: self.missions)
        self._md.start()
        self.addCleanup(self._md.stop)
        self.runner = CliRunner()

    def test_doctor_never_reads_content(self):
        # The rule that stops doctor becoming a second linter, asserted rather
        # than merely written down.
        real_open = builtins.open
        opened = []

        def watched(path, *a, **kw):
            try:
                name = str(path).lower()
            except Exception:
                name = ""
            if name.endswith((".amd", ".mast")):
                opened.append(str(path))
            return real_open(path, *a, **kw)

        with mock.patch.object(subprocess, "run", side_effect=FileNotFoundError()), \
             mock.patch.object(builtins, "open", watched):
            self.runner.invoke(cli, ["doctor"])
        self.assertEqual(opened, [],
                         "doctor opened content files - that is `sbs lint`'s job")


if __name__ == "__main__":
    unittest.main()
