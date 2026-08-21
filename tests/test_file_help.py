"""Tests for file_help: curlretrieve (mocked subprocess) and unzip_exclude.

No real network / no real curl is invoked -- subprocess.run is mocked, and
unzip_exclude is exercised against an in-memory zip written to a temp dir.
"""
import io
import os
import subprocess
import tempfile
import unittest
import zipfile
from unittest import mock

import file_help


class CurlRetrieveTests(unittest.TestCase):
    def test_returns_true_on_success(self):
        fake = mock.Mock(returncode=0, stdout="", stderr="")
        with mock.patch.object(subprocess, "run", return_value=fake) as run:
            ok = file_help.curlretrieve("http://example/x.zip", "out.zip")
        self.assertTrue(ok)
        run.assert_called_once()

    def test_passes_fail_flag(self):
        # -f/--fail is what makes curl exit non-zero on a 404 instead of
        # writing GitHub's HTML error page to disk (issue #1).
        fake = mock.Mock(returncode=0, stdout="", stderr="")
        with mock.patch.object(subprocess, "run", return_value=fake) as run:
            file_help.curlretrieve("http://example/x.zip", "out.zip")
        argv = run.call_args.args[0]
        self.assertIn("-f", argv)

    def test_returns_false_on_http_error(self):
        err = subprocess.CalledProcessError(22, ["curl"], stderr="404")
        with mock.patch.object(subprocess, "run", side_effect=err):
            ok = file_help.curlretrieve("http://example/missing.zip", "out.zip")
        self.assertFalse(ok)

    def test_returns_false_when_curl_missing(self):
        with mock.patch.object(subprocess, "run", side_effect=FileNotFoundError()):
            ok = file_help.curlretrieve("http://example/x.zip", "out.zip")
        self.assertFalse(ok)


def _make_github_archive():
    """Build an in-memory zip shaped like a GitHub archive.

    GitHub wraps everything in a top-level ``<repo>-<branch>/`` folder that
    unzip_exclude is expected to strip.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Repo-main/story.mast", "== main ==\n")
        zf.writestr("Repo-main/media/note.txt", "hi")
        zf.writestr("Repo-main/.github/workflows/ci.yml", "jobs: {}")
    buf.seek(0)
    return buf.read()


class UnzipExcludeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.zip_path = os.path.join(self.tmp, "rel.zip")
        with open(self.zip_path, "wb") as f:
            f.write(_make_github_archive())

    def test_strips_top_folder(self):
        dest = os.path.join(self.tmp, "dest")
        file_help.unzip_exclude(self.zip_path, dest, exclude_files=[])
        # top-level "Repo-main/" is removed: files land directly under dest
        self.assertTrue(os.path.isfile(os.path.join(dest, "story.mast")))
        self.assertTrue(os.path.isfile(os.path.join(dest, "media", "note.txt")))

    def test_honors_excludes(self):
        dest = os.path.join(self.tmp, "dest")
        file_help.unzip_exclude(self.zip_path, dest, exclude_files=[".github/"])
        self.assertFalse(os.path.exists(os.path.join(dest, ".github")))
        self.assertTrue(os.path.isfile(os.path.join(dest, "story.mast")))


if __name__ == "__main__":
    unittest.main()


class DerivedArtIsNeverPackagedTests(unittest.TestCase):
    """zipdir must not put engine-generated art into a library or media pack.

    A .paxmesh BAKES THE FOLDER IT WAS CREATED IN - its texture references are stored as
    paths, so a mesh baked in one folder looks for its textures relative to that folder
    wherever it later ends up. Shipping one hands every install a mesh pointing at
    somebody else's disk: the engine resolves the textures to nothing and dereferences
    NULL in DX11PAXShaderRedwood::Draw3DMesh, which is a crash to desktop.

    Cosmos-TNG-Mod shipped 45 of them for exactly this reason. Its .gitignore already
    excluded them; the packer walked the folder and took them anyway, so "not in git"
    never meant "not in the zip" (2026-08-21).
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.ships = os.path.join(self.tmp, "ships")
        os.makedirs(self.ships)

    def _write(self, path, data=b"x" * 16):
        with open(path, "wb") as f:
            f.write(data)

    def _zip_names(self):
        out = os.path.join(self.tmp, "out.zip")
        file_help.zipdir(self.tmp, out)
        with zipfile.ZipFile(out) as z:
            return {n.replace(chr(92), "/") for n in z.namelist()}

    def test_real_art_is_packaged(self):
        for f in ("FED_Akira.obj", "FED_Akira_diffuse.png", "FED_Akira_normal.png"):
            self._write(os.path.join(self.ships, f))
        names = self._zip_names()
        for f in ("FED_Akira.obj", "FED_Akira_diffuse.png", "FED_Akira_normal.png"):
            self.assertIn("ships/" + f, names)

    def test_generated_meshes_are_not_packaged(self):
        self._write(os.path.join(self.ships, "FED_Akira.obj"))
        for f in ("FED_Akira.paxmesh", "FED_Akira.pointcube", "FED_Akira.rawbitmap"):
            self._write(os.path.join(self.ships, f))
        names = self._zip_names()
        self.assertIn("ships/FED_Akira.obj", names)
        for f in ("FED_Akira.paxmesh", "FED_Akira.pointcube", "FED_Akira.rawbitmap"):
            self.assertNotIn("ships/" + f, names)

    def test_generated_thumbnails_beside_a_mesh_are_not_packaged(self):
        self._write(os.path.join(self.ships, "FED_Akira.obj"))
        self._write(os.path.join(self.ships, "FED_Akira1024.png"))
        self._write(os.path.join(self.ships, "FED_Akira256.png"))
        names = self._zip_names()
        self.assertNotIn("ships/FED_Akira1024.png", names)
        self.assertNotIn("ships/FED_Akira256.png", names)

    def test_a_mission_may_ship_art_whose_name_ends_in_1024(self):
        # The thumbnails are judged by whether the MESH they came from is next to them.
        # Dropping every *1024.png on the name alone would take a mission's own artwork
        # with it, which is a worse failure than the one being prevented.
        self._write(os.path.join(self.tmp, "backdrop1024.png"))
        self._write(os.path.join(self.tmp, "hud256.png"))
        names = self._zip_names()
        self.assertIn("backdrop1024.png", names)
        self.assertIn("hud256.png", names)

    def test_it_reports_what_it_dropped(self):
        # A packer that quietly drops files is indistinguishable from a broken one.
        self._write(os.path.join(self.ships, "FED_Akira.obj"))
        self._write(os.path.join(self.ships, "FED_Akira.paxmesh"))
        out = os.path.join(self.tmp, "out.zip")
        dropped = file_help.zipdir(self.tmp, out)
        self.assertEqual([d.replace(chr(92), "/") for d in dropped],
                         ["ships/FED_Akira.paxmesh"])
