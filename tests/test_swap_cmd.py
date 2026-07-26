"""Tests for swap_cmd: repointing data/missions at a sibling missions_* folder.

Everything runs in a tempfile data dir -- real links (a junction where the test
process lacks symlink rights, a symlink where it has them), never the real
Cosmos install. The link-detection tests are the important ones: `os.path.islink`
is False for a junction, so a naive implementation would call data/missions a
real folder and, on the delete path, take the mission tree with it.
"""
import os
import shutil
import tempfile
import unittest

from click.testing import CliRunner

import swap_cmd
from cli_cmd import cli


def _make_data(root):
    """A data dir with two target sets, each holding a marker file."""
    for name in ("missions_amd", "missions_mast"):
        os.makedirs(os.path.join(root, name))
        with open(os.path.join(root, name, "MARKER.txt"), "w") as f:
            f.write(name)
    return root


class SwapTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.data = _make_data(self.tmp)
        self.link = os.path.join(self.data, "missions")
        self.cwd = os.getcwd()

    def tearDown(self):
        os.chdir(self.cwd)
        if os.path.lexists(self.link) and swap_cmd.is_link(self.link):
            os.rmdir(self.link)  # never rmtree: that would follow into the target
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_swap(self, *args):
        return CliRunner().invoke(cli, ["swap", "--data", self.data, *args])


class LinkDetectionTests(SwapTestCase):
    def test_junction_is_detected_as_a_link(self):
        # THE trap: os.path.islink() is False for a junction. is_link must not be.
        self.run_swap("amd")
        if swap_cmd.link_kind(self.link) != "junction":
            self.skipTest("this process can create symlinks; junction path not exercised")
        self.assertFalse(os.path.islink(self.link), "precondition: islink is False here")
        self.assertTrue(swap_cmd.is_link(self.link))

    def test_real_folder_is_not_a_link(self):
        os.makedirs(self.link)
        self.assertFalse(swap_cmd.is_link(self.link))
        self.assertIsNone(swap_cmd.link_target(self.link))

    def test_missing_path_is_not_a_link(self):
        self.assertFalse(swap_cmd.is_link(self.link))


class FindDataDirTests(SwapTestCase):
    def test_finds_data_dir_from_inside_the_link(self):
        # the normal invocation: sbs runs with the CWD inside data/missions
        self.run_swap("amd")
        self.assertEqual(os.path.realpath(swap_cmd.find_data_dir(self.link)),
                         os.path.realpath(self.data))

    def test_finds_data_dir_from_the_data_dir(self):
        self.assertEqual(os.path.realpath(swap_cmd.find_data_dir(self.data)),
                         os.path.realpath(self.data))

    def test_returns_none_when_nothing_matches(self):
        empty = tempfile.mkdtemp()
        try:
            self.assertIsNone(swap_cmd.find_data_dir(empty))
        finally:
            shutil.rmtree(empty, ignore_errors=True)


class SwapTests(SwapTestCase):
    def test_creates_the_link(self):
        res = self.run_swap("amd")
        self.assertEqual(res.exit_code, 0, res.output)
        self.assertTrue(swap_cmd.is_link(self.link))
        with open(os.path.join(self.link, "MARKER.txt")) as f:
            self.assertEqual(f.read(), "missions_amd")

    def test_repoints_an_existing_link(self):
        self.run_swap("amd")
        res = self.run_swap("mast")
        self.assertEqual(res.exit_code, 0, res.output)
        with open(os.path.join(self.link, "MARKER.txt")) as f:
            self.assertEqual(f.read(), "missions_mast")

    def test_prefix_is_optional(self):
        self.assertEqual(self.run_swap("missions_mast").exit_code, 0)
        with open(os.path.join(self.link, "MARKER.txt")) as f:
            self.assertEqual(f.read(), "missions_mast")

    def test_swapping_leaves_the_old_target_intact(self):
        self.run_swap("amd")
        self.run_swap("mast")
        # the point of the whole exercise: rmdir the link, never its contents
        self.assertTrue(os.path.isfile(os.path.join(self.data, "missions_amd", "MARKER.txt")))

    def test_unknown_target_fails_and_changes_nothing(self):
        res = self.run_swap("nope")
        self.assertEqual(res.exit_code, 2)
        self.assertIn("no such target folder", res.output)
        self.assertFalse(os.path.lexists(self.link))

    def test_status_reports_the_current_target(self):
        self.run_swap("amd")
        res = self.run_swap()
        self.assertEqual(res.exit_code, 0, res.output)
        self.assertIn("missions -> missions_amd", res.output)
        self.assertIn("* missions_amd", res.output)


class RealFolderTests(SwapTestCase):
    def _make_real_missions(self, marker="stock"):
        os.makedirs(self.link)
        with open(os.path.join(self.link, "STOCK.txt"), "w") as f:
            f.write(marker)

    def test_real_folder_is_renamed_not_deleted(self):
        self._make_real_missions()
        res = self.run_swap("amd")
        self.assertEqual(res.exit_code, 0, res.output)
        stock = os.path.join(self.data, "missions_cos", "STOCK.txt")
        self.assertTrue(os.path.isfile(stock), "the real folder must survive as missions_cos")
        with open(stock) as f:
            self.assertEqual(f.read(), "stock")
        self.assertTrue(swap_cmd.is_link(self.link))

    def test_adopted_folder_becomes_a_target(self):
        self._make_real_missions()
        self.run_swap("amd")
        res = self.run_swap("cos")
        self.assertEqual(res.exit_code, 0, res.output)
        self.assertTrue(os.path.isfile(os.path.join(self.link, "STOCK.txt")))

    def test_refuses_when_missions_cos_already_exists(self):
        self._make_real_missions()
        os.makedirs(os.path.join(self.data, "missions_cos"))
        with open(os.path.join(self.data, "missions_cos", "OTHER.txt"), "w") as f:
            f.write("other")
        res = self.run_swap("amd")
        self.assertEqual(res.exit_code, 1)
        self.assertIn("already exists", res.output)
        # nothing moved, nothing deleted
        self.assertTrue(os.path.isfile(os.path.join(self.link, "STOCK.txt")))
        self.assertTrue(os.path.isfile(os.path.join(self.data, "missions_cos", "OTHER.txt")))
        self.assertFalse(swap_cmd.is_link(self.link))


if __name__ == "__main__":
    unittest.main()
