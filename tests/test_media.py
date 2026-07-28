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

    def test_a_single_root_extracts_as_is(self):
        """The pack carries its own namespace folder, so every media path an addon
        already writes keeps its suffix."""
        p = self._pack("u.Demo.media.v1.0.0.zip", ["Demo/casino/card.png", "Demo/logo.png"])
        self.assertTrue(M.unpack_media(p, self.lib))
        self.assertTrue(os.path.exists(os.path.join(self.lib, "media", "Demo", "casino", "card.png")))

    def test_no_single_root_is_wrapped(self):
        """A malformed pack must not spill loose files into the shared root."""
        p = self._pack("u.Loose.media.v1.0.0.zip", ["a.png", "b/c.png"])
        M.unpack_media(p, self.lib)
        key = M.pack_name(p)
        self.assertTrue(os.path.exists(os.path.join(self.lib, "media", key, "a.png")))
        self.assertFalse(os.path.exists(os.path.join(self.lib, "media", "a.png")))

    def test_second_run_is_a_no_op(self):
        p = self._pack("u.Demo.media.v1.0.0.zip", ["Demo/x.png"])
        self.assertTrue(M.unpack_media(p, self.lib))
        self.assertFalse(M.unpack_media(p, self.lib))

    def test_changed_art_re_unpacks_even_at_the_SAME_version(self):
        """The reason the stamp is not just the version: during development the art
        changes while the version stays put."""
        p = self._pack("u.Demo.media.v1.0.0.zip", ["Demo/x.png"])
        M.unpack_media(p, self.lib)
        _zip(p, ["Demo/x.png", "Demo/y.png"])
        self.assertTrue(M.unpack_media(p, self.lib))
        self.assertTrue(os.path.exists(os.path.join(self.lib, "media", "Demo", "y.png")))

    def test_unpack_all_takes_ONE_zip_per_pack(self):
        """`__lib__` accumulates every version ever built; unpacking all of them writes
        the same art N times and flips the stamp on every run."""
        self._pack("u.Demo.media.v1.3.0.zip", ["Demo/old.png"])
        self._pack("u.Demo.media.v1.4.0.zip", ["Demo/new.png"])
        self._pack("u.demo.media.v1.4.0_dev.zip", ["Demo/dev.png"])
        self.assertEqual(M.unpack_all(self.lib), 1)
        root = os.path.join(self.lib, "media", "Demo")
        self.assertTrue(os.path.exists(os.path.join(root, "new.png")))
        self.assertFalse(os.path.exists(os.path.join(root, "dev.png")))
        self.assertFalse(os.path.exists(os.path.join(root, "old.png")))

    def test_a_stale_copy_is_removed_not_merged(self):
        p = self._pack("u.Demo.media.v1.0.0.zip", ["Demo/gone.png"])
        M.unpack_media(p, self.lib)
        _zip(p, ["Demo/kept.png"])
        M.unpack_media(p, self.lib)
        root = os.path.join(self.lib, "media", "Demo")
        self.assertTrue(os.path.exists(os.path.join(root, "kept.png")))
        self.assertFalse(os.path.exists(os.path.join(root, "gone.png")))

    def test_a_bad_zip_is_reported_not_raised(self):
        p = os.path.join(self.lib, "u.Bad.media.v1.0.0.zip")
        open(p, "wb").write(b"not a zip")
        self.assertFalse(M.unpack_media(p, self.lib))


if __name__ == "__main__":
    unittest.main()
