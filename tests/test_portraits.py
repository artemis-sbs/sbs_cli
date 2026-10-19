"""`sbs art portraits` (src/portrait_cmd.py): which hulls, which cells, what is redrawn.

    python tests/test_portraits.py

The renderer is replaced by a fake that records the job, so these run with no browser.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
import portrait_cmd as P

CELL = (256, 256)

_SHIPDATA = """# HJSON, with comments
{
  "#ship-list": [
    { "key": "tsn_cruiser", "artfileroot": "ships/cruiser", "hullpoints": 10 },
    { "key": "kra_cruiser", "artfileroot": "ships/kcruiser", "hullpoints": 10 },
    { "key": "crystal", "artfileroot": "ships/crystal", "side": "pickup" },
    { "key": "tsn_cruiser", "artfileroot": "ships/other", "hullpoints": 1 },
  ]
}
"""


class TestCollect(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.path = os.path.join(self.tmp, "shipData.yaml")
        with open(self.path, "w") as f:
            f.write(_SHIPDATA)

    def test_ships_only_and_the_first_declaration_wins(self):
        got = P.collect_hulls([self.path])
        self.assertEqual(got, [{"key": "tsn_cruiser", "art": "ships/cruiser"},
                               {"key": "kra_cruiser", "art": "ships/kcruiser"}])

    def test_all_takes_pickups_too(self):
        self.assertIn("crystal", [h["key"] for h in P.collect_hulls([self.path], True)])


class TestPlan(unittest.TestCase):
    def test_a_fresh_set_puts_UNKNOWN_FIRST(self):
        cells, todo, cleared = P.plan(None, {"#unknown": "u", "b": "1", "a": "2"}, 16, CELL)
        self.assertEqual((cells["#unknown"]["col"], cells["#unknown"]["row"]), (0, 0))
        self.assertEqual(sorted(todo), ["#unknown", "a", "b"])
        self.assertEqual(cleared, [])

    def test_SLOTS_ARE_STABLE_across_add_and_remove(self):
        cells, _, _ = P.plan(None, {"#unknown": "u", "a": "1", "b": "2", "c": "3"}, 16, CELL)
        m = P.build_manifest("s", "shp_s", CELL, 16, cells, {})
        b_at = (cells["b"]["col"], cells["b"]["row"])
        # `a` removed, `z` added: b keeps its cell, z takes the slot a freed.
        cells2, todo2, cleared2 = P.plan(m, {"#unknown": "u", "b": "2", "c": "3", "z": "9"},
                                         16, CELL)
        self.assertEqual((cells2["b"]["col"], cells2["b"]["row"]), b_at)
        self.assertEqual(todo2, ["z"])
        self.assertEqual(cleared2, [{"page": 0, "col": cells["a"]["col"], "row": 0}])
        self.assertEqual(cells2["z"]["col"], cells["a"]["col"])

    def test_only_a_CHANGED_signature_is_redrawn(self):
        cells, _, _ = P.plan(None, {"#unknown": "u", "a": "1", "b": "2"}, 16, CELL)
        m = P.build_manifest("s", "shp_s", CELL, 16, cells, {})
        _, todo, _ = P.plan(m, {"#unknown": "u", "a": "1", "b": "CHANGED"}, 16, CELL)
        self.assertEqual(todo, ["b"])
        _, todo, _ = P.plan(m, {"#unknown": "u", "a": "1", "b": "2"}, 16, CELL)
        self.assertEqual(todo, [])

    def test_a_new_grid_replaces_every_slot(self):
        cells, _, _ = P.plan(None, {"#unknown": "u", "a": "1"}, 16, CELL)
        m = P.build_manifest("s", "shp_s", CELL, 16, cells, {})
        _, todo, _ = P.plan(m, {"#unknown": "u", "a": "1"}, 8, CELL)
        self.assertEqual(sorted(todo), ["#unknown", "a"])

    def test_pages_and_rows(self):
        wanted = {"#unknown": "u"}
        wanted.update({f"h{i:03}": str(i) for i in range(40)})
        cells, _, _ = P.plan(None, wanted, 4, CELL, max_rows=4)    # 16 per page
        m = P.build_manifest("s", "shp_s", CELL, 4, cells, {})
        self.assertEqual([p["rows"] for p in m["pages"]], [4, 4, 3])
        self.assertEqual(m["extras"]["unknown"]["col"], 0)


class TestEndToEnd(unittest.TestCase):
    """portraits_impl against a fake install and a fake renderer."""

    def setUp(self):
        self.cosmos = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.cosmos, ignore_errors=True)
        self.missions = os.path.join(self.cosmos, "data", "missions")
        ships = os.path.join(self.cosmos, "data", "graphics", "ships")
        os.makedirs(ships)
        os.makedirs(os.path.join(self.missions, "sbs_utils", "cosmos_dev", "mockgui"))
        for n in ("portrait.html", "ship_render.js", "three.min.js"):
            open(os.path.join(self.missions, "sbs_utils", "cosmos_dev", "mockgui", n), "w").close()
        with open(os.path.join(self.cosmos, "data", "shipData.yaml"), "w") as f:
            f.write(_SHIPDATA)
        for root in ("cruiser", "kcruiser"):
            with open(os.path.join(ships, root + ".obj"), "w") as f:
                f.write("v 0 0 0\n")
        self.ships = ships
        self.jobs = []

    def _renderer(self, job, files, cosmos, out_dir, browser=None, show=False):
        self.jobs.append(job)
        keys = []
        for page in job["pages"]:
            with open(os.path.join(out_dir, page["file"] + ".png"), "wb") as f:
                f.write(b"png")
            keys += [i["key"] for i in page["items"]]
        return {"rendered": keys, "failed": []}

    def _run(self, **kw):
        return P.portraits_impl(cosmos=self.cosmos, missions=self.missions,
                                renderer=self._renderer, **kw)

    def _manifest(self):
        with open(os.path.join(self.missions, "sbs_utils", "media", "ship_portraits",
                               "base.json")) as f:
            return json.load(f)

    def test_FIRST_RUN_DRAWS_ALL_SECOND_DRAWS_NOTHING(self):
        self.assertEqual(self._run(), 0)
        self.assertEqual(sorted(i["key"] for i in self.jobs[0]["pages"][0]["items"]),
                         ["#unknown", "kra_cruiser", "tsn_cruiser"])
        m = self._manifest()
        self.assertEqual(sorted(m["cells"]), ["kra_cruiser", "tsn_cruiser"])
        self.assertEqual(m["alias"], "shp_base")
        self.assertEqual(self._run(), 0)
        self.assertEqual(len(self.jobs), 1, "an unchanged install must not render")

    def test_touching_one_texture_redraws_exactly_that_hull(self):
        self._run()
        with open(os.path.join(self.ships, "kcruiser_diffuse.png"), "wb") as f:
            f.write(b"new paint")
        self._run()
        self.assertEqual([i["key"] for i in self.jobs[1]["pages"][0]["items"]], ["kra_cruiser"])

    def test_check_reports_without_drawing(self):
        self.assertEqual(self._run(check=True), 1)
        self.assertEqual(self.jobs, [])
        self._run()
        self.assertEqual(self._run(check=True), 0)

    def test_a_failed_hull_is_retried_next_time(self):
        def flaky(job, *a, **k):
            self._renderer(job, *a, **k)
            return {"rendered": ["#unknown", "tsn_cruiser"],
                    "failed": [{"key": "kra_cruiser", "error": "boom"}]}
        self.assertEqual(P.portraits_impl(cosmos=self.cosmos, missions=self.missions,
                                          renderer=flaky), 1)
        self._run()
        self.assertEqual([i["key"] for i in self.jobs[-1]["pages"][0]["items"]], ["kra_cruiser"])

    def test_missing_art_is_skipped_not_fatal(self):
        os.remove(os.path.join(self.ships, "kcruiser.obj"))
        self.assertEqual(self._run(), 0)
        self.assertEqual(sorted(self._manifest()["cells"]), ["tsn_cruiser"])


class TestArtPath(unittest.TestCase):
    def test_a_mod_root_falls_back_to_its_own_media(self):
        cosmos = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, cosmos, ignore_errors=True)
        media = os.path.join(cosmos, "mod", "media")
        os.makedirs(os.path.join(media, "ships"))
        open(os.path.join(media, "ships", "x.obj"), "w").close()
        got = P.art_path(cosmos, "data/missions/__lib__/media/u.Mod.media.v1/ships/x", media)
        self.assertEqual(got, os.path.join(media, "ships", "x"))


if __name__ == "__main__":
    unittest.main()
