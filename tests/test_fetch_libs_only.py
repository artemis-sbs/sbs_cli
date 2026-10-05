"""`sbs fetch <mission> --libs` - the libraries a mission names, and nothing else.

Every other form of `fetch` REPLACES a mission with the published one. A writer's own
mission had no way to get a library: `sbs create` takes one only when there is none, so
the copy that came with the game stayed for good, and `sbs doctor` answered a missing
library with `run: sbs fetch` - which fetches LegendaryMissions.

Also here: a download lands beside the TOOL. `fetch_deps` wrote to `__lib__` under the
current folder, which is the same place only while the prompt is in `data/missions`.
"""
import json
import os
import tempfile
import unittest
import zipfile
from unittest import mock

from click.testing import CliRunner

import doctor_cmd
import fetch_cmd
import file_help
from cli_cmd import cli

SBSLIB = "artemis-sbs.sbs_utils.v1.4.0.sbslib"
MASTLIB = "artemis-sbs.LegendaryMissions.comms.v1.4.0.mastlib"
DEVLIB = "artemis-sbs.cosmos_dev.v1.4.0.sbslib"


def _zip_with(path, text):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("marker.txt", text)


def _marker(path):
    with zipfile.ZipFile(path) as z:
        return z.read("marker.txt").decode()


class _Missions(unittest.TestCase):
    """A `data/missions` with one mission of the writer's own, and a prompt somewhere else."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.missions = os.path.join(self.tmp.name, "missions")
        self.mission = os.path.join(self.missions, "My Mission")
        os.makedirs(self.mission)
        with open(os.path.join(self.mission, "story.json"), "w") as f:
            json.dump({"sbslib": [SBSLIB], "mastlib": [MASTLIB]}, f)
        with open(os.path.join(self.mission, "mission.amd"), "w") as f:
            f.write("# [Mine](mine)\n")
        self.lib = os.path.join(self.missions, "__lib__")
        os.makedirs(self.lib)
        _zip_with(os.path.join(self.lib, SBSLIB), "old")

        self.elsewhere = os.path.join(self.tmp.name, "elsewhere")
        os.makedirs(self.elsewhere)
        here = os.getcwd()
        os.chdir(self.elsewhere)
        self.addCleanup(os.chdir, here)
        patch = mock.patch.object(fetch_cmd, "zipapp_dir", self.missions)
        patch.start()
        self.addCleanup(patch.stop)
        online = mock.patch.object(fetch_cmd, "_online", lambda: True)
        online.start()
        self.addCleanup(online.stop)

    def mission_files(self):
        out = {}
        for name in sorted(os.listdir(self.mission)):
            with open(os.path.join(self.mission, name), "rb") as f:
                out[name] = f.read()
        return out

    def fetch(self, curl):
        with mock.patch.object(file_help, "curlretrieve", curl):
            return CliRunner().invoke(cli, ["fetch", "My Mission", "--libs"])


class TheLibrariesArrive(_Missions):
    def good(self, url, name):
        _zip_with(name, "new")
        return True

    def test_into_the_tools_lib_not_the_prompts(self):
        result = self.fetch(self.good)
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(sorted(os.listdir(self.lib)), sorted([SBSLIB, MASTLIB, DEVLIB]))
        self.assertEqual(os.listdir(self.elsewhere), [])

    def test_the_dev_library_comes_too_from_the_sbs_utils_release(self):
        # No story.json names it, and lint's compile step and `sbs debug` both need it.
        # It is published on sbs_utils' release: there is no repo called cosmos_dev.
        asked = []

        def good(url, name):
            asked.append(url)
            return self.good(url, name)
        self.fetch(good)
        dev = [u for u in asked if u.endswith(DEVLIB)]
        self.assertEqual(
            dev, ["https://github.com/artemis-sbs/sbs_utils/releases/download/v1.4.0/" + DEVLIB])

    def test_a_library_already_there_is_replaced(self):
        self.fetch(self.good)
        self.assertEqual(_marker(os.path.join(self.lib, SBSLIB)), "new")

    def test_the_mission_is_not_touched(self):
        before = self.mission_files()
        result = self.fetch(self.good)
        self.assertEqual(self.mission_files(), before)
        self.assertIn("itself was not changed", result.output)

    def test_from_inside_the_mission_with_a_dot(self):
        os.chdir(self.mission)
        before = self.mission_files()
        with mock.patch.object(file_help, "curlretrieve", self.good):
            result = CliRunner().invoke(cli, ["fetch", ".", "--libs"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(_marker(os.path.join(self.lib, SBSLIB)), "new")
        self.assertEqual(self.mission_files(), before)


class TheDownloadFails(_Missions):
    def test_the_old_library_stays_and_the_command_says_so(self):
        def bad(url, name):
            with open(name, "w") as f:
                f.write("Not Found")
            return True
        result = self.fetch(bad)
        self.assertEqual(result.exit_code, 1)
        self.assertEqual(_marker(os.path.join(self.lib, SBSLIB)), "old")
        self.assertEqual(os.listdir(self.lib), [SBSLIB])       # no half file left behind
        self.assertIn("could not be fetched", result.output)

    def test_a_folder_that_is_not_a_mission(self):
        with mock.patch.object(file_help, "curlretrieve", lambda url, name: self.fail(url)):
            result = CliRunner().invoke(cli, ["fetch", "No Such Mission", "--libs"])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("story.json", result.output)


class DoctorNamesACommandThatMends(_Missions):
    def test_a_missing_library_points_at_libs(self):
        rep = doctor_cmd.Report()
        with mock.patch.object(doctor_cmd, "_missions_dir", lambda: self.missions):
            doctor_cmd._check_mission(rep, self.mission)
        row = [r for r in rep.rows if r["name"] == "libraries"][0]
        self.assertEqual(row["status"], doctor_cmd.PROBLEM)
        self.assertIn('sbs fetch "My Mission" --libs', row["remedy"])


if __name__ == "__main__":
    unittest.main()
