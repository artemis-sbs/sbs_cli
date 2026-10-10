"""A `//shared/signal/x` route in a packaged addon is a route for `x`.

`sbs lint` reads the mission's mastlibs for the signals they answer. It kept lines that
start `//signal/` and dropped `//shared/signal/`, so a signal a packaged addon answers on
the server looked unanswered: a universe's site hail (`; signal boarding_down`) and a
boarded ship's endings drew `signal-no-route` in any mission that loads those addons as
mastlibs. The addons' own repos never saw it, because there the source is in the folder.
"""
import json
import os
import tempfile
import unittest
import zipfile

import lint_cmd


class SharedRoutesInAMastlib(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.missions = self.tmp.name
        self.mission = os.path.join(self.missions, "MyUniverse")
        os.makedirs(self.mission)
        os.makedirs(os.path.join(self.missions, "__lib__"))
        lib = "owner.Repo.addon.v1.mastlib"
        with zipfile.ZipFile(os.path.join(self.missions, "__lib__", lib), "w") as z:
            z.writestr("__init__.mast", "import routes.mast\n")
            z.writestr("routes.mast",
                       "//shared/signal/boarding_down\n    ->END\n"
                       "//signal/plain_one\n    ->END\n"
                       "== not_a_route ==\n    x = 1\n")
        with open(os.path.join(self.mission, "story.json"), "w") as f:
            json.dump({"mastlib": [lib]}, f)

    def source(self):
        return lint_cmd._mastlib_signal_source(self.missions, self.mission) or ""

    def test_THE_SHARED_ROUTE_IS_KEPT(self):
        self.assertIn("//shared/signal/boarding_down", self.source())

    def test_the_plain_route_is_still_kept(self):
        self.assertIn("//signal/plain_one", self.source())

    def test_other_lines_are_still_left_out(self):
        self.assertNotIn("not_a_route", self.source())


if __name__ == "__main__":
    unittest.main()
