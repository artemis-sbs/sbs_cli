"""Shared-media unpacking (src/media_cmd.py).

    python tests/test_media.py
"""
import os, sys, json, shutil, tempfile, zipfile, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
import media_cmd as M


def _zip(path, names):
    with zipfile.ZipFile(path, "w") as zf:
        for n in names:
            zf.writestr(n, "x" * 10)


class NamesAndVersions(unittest.TestCase):
    def test_one_pack_however_it_is_spelled(self):
        """`__lib__` holds both spellings of the same pack; two keys would unpack the
        same art twice, each overwriting the other."""
        self.assertEqual(M.pack_name("artemis-sbs.LegendaryMissions.media.v1.4.0.zip"),
                         M.pack_name("artemis-sbs.legendaryMissions.media.v1.4.0_dev.zip"))

    def test_a_suffixed_build_sorts_BELOW_its_release(self):
        """Appending the suffix to the numbers made `v1.4.0_dev` beat `v1.4.0` - a longer
        tuple wins a prefix comparison - and the stale dev pack landed over the real one."""
        rel = M.pack_version("p.media.v1.4.0.zip")
        dev = M.pack_version("p.media.v1.4.0_dev.zip")
        old = M.pack_version("p.media.v1.3.0.zip")
        self.assertGreater(rel, dev)
        self.assertGreater(dev, old)


class Unpacking(unittest.TestCase):
    def setUp(self):
        self.lib = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.lib, ignore_errors=True)

    def _pack(self, name, entries):
        p = os.path.join(self.lib, name)
        _zip(p, entries)
        return p

    def _at(self, *parts):
        return os.path.join(self.lib, "media", *parts)

    def test_unpacks_into_a_folder_named_for_the_zip(self):
        """The zip name is already unique per pack AND version, so nothing has to invent
        a namespace and a pack needs no wrapper folder of its own."""
        p = self._pack("u.Demo.media.v1.0.0.zip", ["casino/card.png", "logo.png"])
        self.assertTrue(M.unpack_media(p, self.lib))
        self.assertTrue(os.path.exists(self._at("u.Demo.media.v1.0.0", "casino", "card.png")))

    def test_two_pinned_versions_live_side_by_side(self):
        """The reason for versioned folders: seven missions pin v1.4.0 while
        module_3_bases pins v1.1.0, and one shared folder would hand one of them art it
        never asked for."""
        self._pack("u.Demo.media.v1.1.0.zip", ["casino/old.png"])
        self._pack("u.Demo.media.v1.4.0.zip", ["casino/new.png"])
        self.assertEqual(M.unpack_all(self.lib), 2)
        self.assertTrue(os.path.exists(self._at("u.Demo.media.v1.1.0", "casino", "old.png")))
        self.assertTrue(os.path.exists(self._at("u.Demo.media.v1.4.0", "casino", "new.png")))

    def test_second_run_is_a_no_op(self):
        p = self._pack("u.Demo.media.v1.0.0.zip", ["casino/x.png"])
        self.assertTrue(M.unpack_media(p, self.lib))
        self.assertFalse(M.unpack_media(p, self.lib))

    def test_changed_art_re_unpacks_even_at_the_SAME_version(self):
        """Why the stamp is not just the version: during development the art changes
        while the version stays put."""
        p = self._pack("u.Demo.media.v1.0.0.zip", ["casino/x.png"])
        M.unpack_media(p, self.lib)
        _zip(p, ["casino/x.png", "casino/y.png"])
        self.assertTrue(M.unpack_media(p, self.lib))
        self.assertTrue(os.path.exists(self._at("u.Demo.media.v1.0.0", "casino", "y.png")))

    def test_a_dropped_file_disappears(self):
        p = self._pack("u.Demo.media.v1.0.0.zip", ["casino/gone.png"])
        M.unpack_media(p, self.lib)
        _zip(p, ["casino/kept.png"])
        M.unpack_media(p, self.lib)
        self.assertTrue(os.path.exists(self._at("u.Demo.media.v1.0.0", "casino", "kept.png")))
        self.assertFalse(os.path.exists(self._at("u.Demo.media.v1.0.0", "casino", "gone.png")))

    def test_a_bad_zip_is_reported_not_raised(self):
        p = os.path.join(self.lib, "u.Bad.media.v1.0.0.zip")
        open(p, "wb").write(b"not a zip")
        self.assertFalse(M.unpack_media(p, self.lib))


class Pruning(unittest.TestCase):
    def setUp(self):
        self.lib = tempfile.mkdtemp()
        self.missions = tempfile.mkdtemp()

    def tearDown(self):
        for d in (self.lib, self.missions):
            shutil.rmtree(d, ignore_errors=True)

    def _mission(self, name, pack):
        d = os.path.join(self.missions, name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "story.json"), "w", encoding="utf-8") as f:
            json.dump({"resources": {"media": pack}}, f)

    def test_pinned_packs_reads_every_story(self):
        self._mission("a", "u.Demo.media.v1.4.0.zip")
        self._mission("b", "u.Demo.media.v1.1.0.zip")
        self.assertEqual(M.pinned_packs(self.missions),
                         {"u.Demo.media.v1.4.0.zip", "u.Demo.media.v1.1.0.zip"})

    def test_prune_keeps_what_is_pinned_and_drops_the_rest(self):
        for v in ("v1.1.0", "v1.4.0", "v0.9.0"):
            _zip(os.path.join(self.lib, "u.Demo.media.%s.zip" % v), ["casino/x.png"])
        M.unpack_all(self.lib, quiet=True)
        self._mission("a", "u.Demo.media.v1.4.0.zip")
        self._mission("b", "u.Demo.media.v1.1.0.zip")
        self.assertEqual(M.prune_media(self.lib, M.pinned_packs(self.missions), quiet=True), 1)
        left = sorted(d for d in os.listdir(os.path.join(self.lib, "media")) if not d.startswith("."))
        self.assertEqual(left, ["u.Demo.media.v1.1.0", "u.Demo.media.v1.4.0"])

    def test_pruning_forgets_the_stamp_too(self):
        _zip(os.path.join(self.lib, "u.Gone.media.v1.0.0.zip"), ["casino/x.png"])
        M.unpack_all(self.lib, quiet=True)
        M.prune_media(self.lib, set(), quiet=True)
        with open(os.path.join(self.lib, "media", ".stamp.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), {})


class BuildingWithoutTheSource(unittest.TestCase):
    """`fetch` calls `lib_impl` right after downloading, and a fetched copy can
    legitimately lack a folder its manifest lists - `media/` is `export-ignore`d out of
    the GitHub archive because the art travels as its own pack. Zipping a folder that is
    not there wrote an EMPTY zip over the real pack in `__lib__`; the unpacker then saw a
    changed listing and replaced the shared art with nothing, blanking every mission that
    reads it."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, "__lib__"))
        self.mission = os.path.join(self.root, "Demo")
        os.makedirs(os.path.join(self.mission, "code"))
        open(os.path.join(self.mission, "code", "a.mast"), "w").write("x")
        with open(os.path.join(self.mission, "__lib__.json"), "w") as f:
            json.dump({"version": "v1.0.0", "mastlib": ["code"], "zip": ["media"]}, f)
        self.pack = os.path.join(self.root, "__lib__", "artemis-sbs.Demo.media.v1.0.0.zip")
        _zip(self.pack, ["casino/card.png"])

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _build(self):
        import cli_cmd, lib_cmd
        cli_cmd.zipapp_dir = self.root
        lib_cmd.zipapp_dir = self.root
        lib_cmd.lib_impl("Demo", "artemis-sbs")

    def test_a_missing_source_folder_does_not_clobber_the_pack(self):
        self._build()
        self.assertEqual(len(zipfile.ZipFile(self.pack).namelist()), 1)

    def test_an_empty_source_folder_does_not_either(self):
        os.makedirs(os.path.join(self.mission, "media"))
        self._build()
        self.assertEqual(len(zipfile.ZipFile(self.pack).namelist()), 1)

    def test_a_real_source_folder_still_builds(self):
        art = os.path.join(self.mission, "media", "casino")
        os.makedirs(art)
        open(os.path.join(art, "new.png"), "w").write("art")
        self._build()
        names = zipfile.ZipFile(self.pack).namelist()
        self.assertTrue(any("new.png" in n for n in names), names)


if __name__ == "__main__":
    unittest.main()
