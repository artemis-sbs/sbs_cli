"""`sbs site` - the generated-block refill, and the check that guards it.

The command exists because hand-copied AMD in documentation drifts, and one drifted
copy taught `When:` as the completion trigger when it is an alias of `Starts when:`,
the start one. A quest written from that page never completes.

So the load-bearing test here is not that the command runs - it is
`test_check_fails_when_a_source_amd_moved_on`. Without that, regeneration is something
a person has to remember, which is the same failure mode wearing a tool's clothes.
"""
import os
import sys
import tempfile
import unittest

from click.testing import CliRunner

import main  # noqa: F401 - registers every command on the cli group
from cli_cmd import cli

_REAL_MISSIONS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

AMD = """\
# [Warlord](warlord)
---
Boss
Trigger: enemies_low
Low: 25%
---
A raider warlord warps in.
"""


class _Fixture(unittest.TestCase):
    def setUp(self):
        if not os.path.isdir(os.path.join(_REAL_MISSIONS, "sbs_utils")):
            self.skipTest("sbs_utils working tree not beside sbs_cli")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # A mission-shaped tree INSIDE a missions-shaped parent, because the command
        # resolves sbs_utils relative to the mission's parent.
        self.mission = os.path.join(_REAL_MISSIONS, "__site_test_mission__")
        os.makedirs(os.path.join(self.mission, "maps", "bosses"), exist_ok=True)
        os.makedirs(os.path.join(self.mission, "mkdocs", "docs"), exist_ok=True)
        self.addCleanup(self._rmtree, self.mission)
        self.amd = os.path.join(self.mission, "maps", "bosses", "warlord.amd")
        self.write(self.amd, AMD)
        self.page = os.path.join(self.mission, "mkdocs", "docs", "bosses.md")
        self.runner = CliRunner()

    @staticmethod
    def _rmtree(path):
        import shutil
        shutil.rmtree(path, ignore_errors=True)

    @staticmethod
    def write(path, text, newline="\n"):
        with open(path, "w", encoding="utf-8", newline=newline) as f:
            f.write(text)

    @staticmethod
    def read(path):
        with open(path, encoding="utf-8", newline="") as f:
            return f.read()

    def site(self, *args):
        return self.runner.invoke(cli, ["site", self.mission, *args])

    def page_with(self, directive, body="STALE\n", newline="\n"):
        self.write(self.page,
                   f"Prose above.\n\n<!-- amd:begin {directive} -->\n{body}"
                   f"<!-- amd:end -->\n\nProse below.\n", newline=newline)


class TestRefill(_Fixture):
    def test_a_stale_block_is_replaced_and_the_prose_is_not(self):
        self.page_with("excerpt maps/bosses/warlord.amd#warlord")
        res = self.site()
        self.assertEqual(res.exit_code, 0, res.output)
        out = self.read(self.page)
        self.assertNotIn("STALE", out)
        self.assertIn("Trigger: enemies_low", out)
        self.assertIn("Prose above.", out)
        self.assertIn("Prose below.", out)

    def test_a_page_with_no_markers_is_never_rewritten(self):
        self.write(self.page, "just prose\n")
        before = os.path.getmtime(self.page)
        self.site()
        self.assertEqual(self.read(self.page), "just prose\n")
        self.assertEqual(os.path.getmtime(self.page), before)

    def test_running_twice_changes_nothing_the_second_time(self):
        self.page_with("fields quest --only done when")
        self.site()
        once = self.read(self.page)
        res = self.site()
        self.assertEqual(self.read(self.page), once)
        self.assertIn("0 page(s) updated", res.output)

    def test_crlf_is_preserved(self):
        # These pages live in Windows repos with autocrlf. Normalizing line endings
        # rewrites every line of the file and buries the one real change.
        self.page_with("fields quest --only done when", newline="\r\n")
        self.site()
        out = self.read(self.page)
        self.assertIn("\r\n", out)
        self.assertEqual(out.count("\n"), out.count("\r\n"))


class TestCheck(_Fixture):
    def test_check_passes_when_everything_is_current(self):
        self.page_with("excerpt maps/bosses/warlord.amd#warlord")
        self.site()
        self.assertEqual(self.site("--check").exit_code, 0)

    def test_check_fails_when_a_source_amd_moved_on(self):
        # The whole point. Someone edits a record and does not regenerate; without
        # this the docs silently go stale again and nothing says so.
        self.page_with("excerpt maps/bosses/warlord.amd#warlord")
        self.site()
        self.write(self.amd, AMD.replace("Low: 25%", "Low: 40%"))
        res = self.site("--check")
        self.assertEqual(res.exit_code, 1)
        self.assertIn("STALE", res.output)
        self.assertIn("out of date", res.output)

    def test_check_writes_nothing(self):
        self.page_with("excerpt maps/bosses/warlord.amd#warlord")
        before = self.read(self.page)
        self.site("--check")
        self.assertEqual(self.read(self.page), before)

    def test_check_names_the_directive_that_went_stale(self):
        self.page_with("excerpt maps/bosses/warlord.amd#warlord")
        self.site()
        self.write(self.amd, AMD.replace("Low: 25%", "Low: 40%"))
        self.assertIn("excerpt maps/bosses/warlord.amd#warlord",
                      self.site("--check").output)


class TestFailures(_Fixture):
    def test_an_unknown_directive_fails_the_run(self):
        # Degrading to a warning would leave the stale copy in place, which is the
        # exact failure this command exists to end.
        self.page_with("frobnicate whatever")
        res = self.site()
        self.assertNotEqual(res.exit_code, 0)
        self.assertIn("frobnicate", res.output)

    def test_a_missing_source_file_names_itself(self):
        self.page_with("excerpt maps/bosses/nope.amd")
        res = self.site()
        self.assertNotEqual(res.exit_code, 0)
        self.assertIn("nope.amd", res.output)

    def test_a_folder_with_no_docs_tree_says_so(self):
        import shutil
        shutil.rmtree(os.path.join(self.mission, "mkdocs"))
        res = self.site()
        self.assertNotEqual(res.exit_code, 0)
        self.assertIn("docs", res.output)


class TestOneMissionPerProcess(_Fixture):
    """`amd_register_fields` is process-global and CUMULATIVE.

    Load two missions into one interpreter and the second `fields` table lists the
    first mission's fields as well - Open Universe's `Standing:` turned up in the core
    library's own quest table exactly this way. The output then depends on the ORDER
    missions were loaded in, and an order-dependent generator is worse than the
    hand-written table it replaces. One `sbs site` documents one mission; the guard
    turns a second one into a loud error instead of a quietly wrong table."""

    def test_a_second_mission_in_the_same_process_is_refused(self):
        self.page_with("fields quest --only done when")
        self.assertEqual(self.site().exit_code, 0)
        other = os.path.join(_REAL_MISSIONS, "sbs_utils")
        res = self.runner.invoke(cli, ["site", other, "--check"])
        self.assertNotEqual(res.exit_code, 0)
        self.assertIn("one mission per process", res.output)

    def test_the_same_mission_twice_is_fine(self):
        self.page_with("fields quest --only done when")
        self.assertEqual(self.site().exit_code, 0)
        self.assertEqual(self.site("--check").exit_code, 0)


class TestTheShippedRepos(unittest.TestCase):
    """The repos next door must actually be up to date.

    Each check runs in its OWN interpreter - both because that is how `sbs site` is
    really invoked, and because sharing one would trip the one-mission guard above."""

    def _check(self, repo):
        import subprocess
        path = os.path.join(_REAL_MISSIONS, repo)
        if not os.path.isdir(os.path.join(path, "mkdocs", "docs")):
            self.skipTest(f"{repo} working tree not beside sbs_cli")
        src = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src"))
        code = ("import sys\n"
                "sys.path.insert(0, sys.argv[1])\n"
                "import main\n"
                "from click.testing import CliRunner\n"
                "from cli_cmd import cli\n"
                "r = CliRunner().invoke(cli, ['site', sys.argv[2], '--check'])\n"
                "print(r.output)\n"
                "sys.exit(r.exit_code)\n")
        res = subprocess.run([sys.executable, "-c", code, src, path],
                             capture_output=True, text=True)
        self.assertEqual(res.returncode, 0,
                         f"{repo} has stale generated blocks:\n"
                         f"{res.stdout}{res.stderr}")

    def test_sbs_utils_docs_are_current(self):
        self._check("sbs_utils")

    def test_legendary_missions_docs_are_current(self):
        self._check("LegendaryMissions")

    def test_open_universe_docs_are_current(self):
        self._check("OpenUniverse")


if __name__ == "__main__":
    unittest.main()
