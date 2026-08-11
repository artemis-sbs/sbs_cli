"""Baking a `face://` composite to a PNG.

The rule these tests defend is BOTH, OR NEITHER: a page either composites every face
or names every face, never a mix. A half-capable renderer emits an image tag pointing
at nothing, which tells the reader the art exists and failed to load - a different and
wrong story from "this is a face and we are describing it".

The parsing tests are against `face.js`'s own behavior, because that file is the
definition of what a face string means and this is a second implementation of it.
"""
import os
import tempfile
import unittest

_REAL_MISSIONS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _with_sbs_utils(case):
    import sys
    repo = os.path.join(_REAL_MISSIONS, "sbs_utils")
    if not os.path.isdir(repo):
        case.skipTest("sbs_utils working tree not beside sbs_cli")
    if repo not in sys.path:
        sys.path.insert(0, repo)
        case.addCleanup(sys.path.remove, repo)


class TestParsing(unittest.TestCase):
    """`alias color col row [ox] [oy]`, `;`-separated, with an optional `?height=`."""

    def setUp(self):
        _with_sbs_utils(self)
        global _parse, _color
        from face_bake import _parse, _color

    def test_a_layer_stack(self):
        layers, height = _parse("arv #ffffff 0 0;arv #ff0000 2 1", 96)
        self.assertEqual(len(layers), 2)
        self.assertEqual(layers[0]["alias"], "arv")
        self.assertEqual((layers[1]["col"], layers[1]["row"]), (2, 1))
        self.assertEqual(layers[1]["rgb"], (255, 0, 0))
        self.assertEqual(height, 96)

    def test_offsets_are_optional(self):
        layers, _ = _parse("ter #ffffff 3 0 5 7", 96)
        self.assertEqual((layers[0]["ox"], layers[0]["oy"]), (5, 7))
        layers, _ = _parse("ter #ffffff 3 0", 96)
        self.assertEqual((layers[0]["ox"], layers[0]["oy"]), (0, 0))

    def test_height_is_read_and_clamped(self):
        self.assertEqual(_parse("arv #fff 0 0?height=120", 96)[1], 120)
        self.assertEqual(_parse("arv #fff 0 0?height=99999", 96)[1], 512)

    def test_a_short_layer_is_dropped_not_defaulted(self):
        # face.js drops it too: a half-written layer is not a face, and guessing the
        # missing coordinate puts the wrong part of the sheet on the page.
        layers, _ = _parse("arv #ffffff 0;arv #ffffff 1 1", 96)
        self.assertEqual(len(layers), 1)

    def test_a_trailing_semicolon_is_harmless(self):
        # Every face in the shipped lore ends with one.
        layers, _ = _parse("arv #ffffff 0 0;arv #ffffff 0 2;", 96)
        self.assertEqual(len(layers), 2)

    def test_colors(self):
        self.assertEqual(_color("#ff8800"), (255, 136, 0))
        self.assertEqual(_color("#f80"), (255, 136, 0))
        self.assertEqual(_color("white"), (255, 255, 255))
        # Unrecognized -> white, which is face.js's answer: no tint beats a wrong one.
        self.assertEqual(_color("chartreuse-ish"), (255, 255, 255))


class TestBaking(unittest.TestCase):
    def setUp(self):
        _with_sbs_utils(self)
        try:
            import PIL  # noqa: F401
        except ImportError:
            self.skipTest("PIL not installed")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _baker(self, mission="LegendaryMissions"):
        from sbs_utils.procedural.amd_assets import MissionAssets
        from face_bake import FaceBaker
        path = os.path.join(_REAL_MISSIONS, mission)
        if not os.path.isdir(path):
            self.skipTest(f"{mission} not beside sbs_cli")
        return FaceBaker(MissionAssets(path, embed=False),
                         os.path.join(self.tmp.name, "faces"), "media/faces")

    def test_a_real_face_bakes_to_a_png(self):
        baker = self._baker()
        if not baker.capable():
            self.skipTest("race atlases not available on this machine")
        url = baker.bake("arv #ffffff 0 0;arv #ffffff 0 2;")
        self.assertTrue(url.endswith(".png"))
        target = os.path.join(self.tmp.name, "faces", os.path.basename(url))
        self.assertTrue(os.path.isfile(target))
        from PIL import Image
        with Image.open(target) as im:
            self.assertEqual(im.mode, "RGBA")
            self.assertEqual(im.height, 96)
            # Something was actually drawn - an all-transparent PNG is the failure
            # mode where the crop landed off the sheet.
            self.assertTrue(im.getchannel("A").getextrema()[1] > 0)

    def test_the_name_is_content_addressed(self):
        # The PNGs are committed, so an unchanged face must produce byte-identical
        # output or every regeneration churns the repo.
        baker = self._baker()
        if not baker.capable():
            self.skipTest("race atlases not available on this machine")
        spec = "arv #ffffff 0 0;"
        first = baker.bake(spec)
        self.assertEqual(baker.bake(spec), first)
        other = self._baker()
        self.assertEqual(other.bake(spec), first)

    def test_a_tint_differs_from_no_tint(self):
        baker = self._baker()
        if not baker.capable():
            self.skipTest("race atlases not available on this machine")
        plain = baker.bake("zim #ffffff 0 0;")
        tinted = baker.bake("zim #ebb5b5 0 0;")
        self.assertNotEqual(plain, tinted)

    def test_an_unknown_race_bakes_nothing_rather_than_a_blank(self):
        baker = self._baker()
        self.assertIsNone(baker.bake("nosuchrace #ffffff 0 0;"))

    def test_an_empty_spec_bakes_nothing(self):
        self.assertIsNone(self._baker().bake(""))


class TestCapability(unittest.TestCase):
    """Both, or neither - asked once, up front."""

    def setUp(self):
        _with_sbs_utils(self)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_no_atlases_means_not_capable(self):
        from face_bake import FaceBaker

        class NoAssets:
            def find(self, _name):
                return None

        baker = FaceBaker(NoAssets(), os.path.join(self.tmp.name, "f"), "m/f")
        self.assertFalse(baker.capable())

    def test_an_incapable_baker_writes_nothing(self):
        from face_bake import FaceBaker

        class NoAssets:
            def find(self, _name):
                return None

        out = os.path.join(self.tmp.name, "f")
        baker = FaceBaker(NoAssets(), out, "m/f")
        baker.bake("arv #ffffff 0 0;")
        self.assertFalse(os.path.isdir(out),
                         "an incapable baker created a directory it never filled")

    def test_an_already_baked_face_resolves_with_no_atlas_at_all(self):
        """The property that makes the generated pages reproducible off a machine with
        no Cosmos install - CI, and anyone who only edits prose.

        A face PNG is named from its SPEC, so once composited and committed it can be
        referenced without ever opening an atlas. Without this, CI regenerates every
        face as a text note, disagrees with the committed page and reports drift that
        is not there."""
        from face_bake import FaceBaker

        class NoAssets:
            def find(self, _name):
                return None

        out = os.path.join(self.tmp.name, "f")
        spec = "arv #ffffff 0 0;"
        baker = FaceBaker(NoAssets(), out, "m/f")
        self.assertFalse(baker.capable())
        self.assertIsNone(baker.bake(spec), "a NEW face must still fail loudly")

        # Now pretend a developer with the atlases composited and committed it.
        os.makedirs(out, exist_ok=True)
        name = os.path.basename(FaceBaker(NoAssets(), out, "m/f")
                                ._name_for(spec))
        with open(os.path.join(out, name), "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n")
        again = FaceBaker(NoAssets(), out, "m/f")
        self.assertEqual(again.bake(spec), f"m/f/{name}")


if __name__ == "__main__":
    unittest.main()
