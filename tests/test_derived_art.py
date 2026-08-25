"""The derived-art invariant: a `.paxmesh` never stands without its sprites.

WHY THIS IS WORTH A TEST FILE. A hull whose mesh is baked but whose sprites are not crashes
the client on EVERY draw of that hull, permanently - the engine retries the bake, dies at
the same point, and leaves the same wreckage. Three hulls in one install cost two separate
crash investigations before anyone looked at the folder.

The rule is MEASURED, not assumed. Across the 201 art roots in a stock `data/graphics/ships`
exactly three combinations occur: paxmesh+1024+256 (120), the same plus `.pointcube` (64),
and nothing at all (17). So `.pointcube` is optional - requiring it flags 120 healthy roots -
and the three that travel together are the invariant.
"""
import os
import tempfile
import shutil
import unittest

import file_help


class DerivedArtStatusTests(unittest.TestCase):

    def setUp(self):
        # A `ships` FOLDER, deliberately: the sprite requirement is scoped to one. In a
        # tmpdir named anything else these would be testing the effect-mesh rule instead,
        # and every "half" assertion below would quietly pass as "complete".
        self.top = tempfile.mkdtemp()
        self.dir = os.path.join(self.top, "ships")
        os.makedirs(self.dir)

    def tearDown(self):
        shutil.rmtree(self.top, ignore_errors=True)

    def _put(self, *names):
        for n in names:
            open(os.path.join(self.dir, n), "w").close()

    def _state(self, root):
        return file_help.derived_art_status(self.dir).get(root, {}).get("state")

    def test_the_complete_set_is_complete(self):
        self._put("a.obj", "a.paxmesh", "a1024.png", "a256.png")
        self.assertEqual("complete", self._state("a"))

    def test_pointcube_is_optional(self):
        """120 healthy stock roots have no .pointcube. Requiring it flags every one."""
        self._put("a.obj", "a.paxmesh", "a1024.png", "a256.png")
        self.assertEqual("complete", self._state("a"))
        self._put("b.obj", "b.paxmesh", "b1024.png", "b256.png", "b.pointcube")
        self.assertEqual("complete", self._state("b"))

    def test_rawbitmap_is_optional(self):
        """Never observed being generated under any trigger tried."""
        self._put("a.obj", "a.paxmesh", "a1024.png", "a256.png")
        self.assertEqual("complete", self._state("a"))

    def test_nothing_derived_is_unbaked_not_broken(self):
        """Art nobody has drawn yet. Calling this a problem would flag a fresh install."""
        self._put("a.obj")
        self.assertEqual("unbaked", self._state("a"))

    def test_a_mesh_without_its_sprites_is_HALF(self):
        """The crashing state, and the one this whole file exists for."""
        self._put("a.obj", "a.paxmesh")
        self.assertEqual("half", self._state("a"))
        self.assertEqual(["1024.png", "256.png"],
                         file_help.derived_art_status(self.dir)["a"]["absent"])

    def test_one_sprite_missing_is_still_half(self):
        self._put("a.obj", "a.paxmesh", "a1024.png")
        self.assertEqual("half", self._state("a"))

    def test_a_root_with_no_source_mesh_is_not_invented(self):
        """A stray `foo256.png` must not conjure an art root that never existed."""
        self._put("stray256.png")
        self.assertEqual({}, file_help.derived_art_status(self.dir))

    def test_a_missing_folder_is_quiet(self):
        self.assertEqual({}, file_help.derived_art_status(
            os.path.join(self.dir, "nope")))

    def test_sprites_are_only_required_in_a_ships_folder(self):
        """Measured: graphics/ships has 184 roots with sprites and 0 without; the graphics
        ROOT has 9 without and 0 with. The effect meshes there - typhon parts, drones,
        AHBall - are only ever drawn in 3D, so the engine never makes them a flat sprite.
        Requiring sprites everywhere reports all 9 as broken on a clean install."""
        effects = os.path.join(self.top, "graphics")
        os.makedirs(effects)
        for n in ("typhon-needle.obj", "typhon-needle.paxmesh"):
            open(os.path.join(effects, n), "w").close()
        st = file_help.derived_art_status(effects)
        self.assertEqual("complete", st["typhon-needle"]["state"],
                         "an effect mesh was reported broken for lacking sprites it "
                         "never gets")

    def test_matching_ignores_case(self):
        """shipData spells artfileroots inconsistently - `Ximni_Corvette` beside
        `ximni_escort` - so a case-sensitive compare would report healthy art as broken."""
        self._put("Mixed.obj", "mixed.paxmesh", "MIXED1024.png", "Mixed256.png")
        self.assertEqual("complete", self._state("Mixed"))


class DerivedArtFilesTests(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _put(self, *names):
        for n in names:
            open(os.path.join(self.dir, n), "w").close()

    def test_it_lists_every_derived_file_including_the_optional_ones(self):
        """Clearing has to take `.pointcube` and `.rawbitmap` too, or the re-bake starts
        from a folder that is still partly stale."""
        self._put("a.obj", "a.paxmesh", "a.pointcube", "a.rawbitmap",
                  "a1024.png", "a256.png")
        self.assertEqual(
            ["a.paxmesh", "a.pointcube", "a.rawbitmap", "a1024.png", "a256.png"],
            file_help.derived_art_files(self.dir, "a"))

    def test_it_never_lists_the_source_art(self):
        """Deleting the .obj or a texture would destroy authored content."""
        self._put("a.obj", "a.mtl", "a_diffuse.png", "a_normal.png", "a.paxmesh")
        self.assertEqual(["a.paxmesh"], file_help.derived_art_files(self.dir, "a"))

    def test_a_longer_root_is_not_swept_up_by_a_shorter_one(self):
        """`monster2` must not take `monster21024.png`'s neighbour `monster2_body.obj`, nor
        may `alien1` claim `alien10`'s files."""
        self._put("alien1.obj", "alien1.paxmesh",
                  "alien10.obj", "alien10.paxmesh", "alien101024.png")
        self.assertEqual(["alien1.paxmesh"], file_help.derived_art_files(self.dir, "alien1"))
