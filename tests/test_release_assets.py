"""A lib's LOCAL filename is not always what it is PUBLISHED as.

Libs live in `__lib__/` (and are named in story.json) as
`{user}.{repo}.{folder}.{version}.{ext}`, and that is now what LegendaryMissions
publishes too. Tags cut before its workflow was fixed carry the bare
`{folder}.{version}.{ext}` instead, so the canonical name is tried first and the bare one
is kept as a fallback.

`sbs debug --refresh-libs` used to request the local name with no fallback, so against
those older tags every LM mastlib 404'd and was reported as "kept existing" - which looks
like success on any box that had already run `sbs lib LegendaryMissions`, and fails
everywhere else.
"""
import os
import tempfile
import unittest
import zipfile
from unittest import mock

import debug_cmd
import file_help

SBSLIB = "artemis-sbs.sbs_utils.v1.4.0.sbslib"
MASTLIB = "artemis-sbs.LegendaryMissions.consoles.v1.4.0.mastlib"
MEDIA = "artemis-sbs.LegendaryMissions.media.v1.4.0.zip"


class ReleaseAssetCandidateTests(unittest.TestCase):
    def test_sbslib_keeps_the_prefix_first(self):
        self.assertEqual(file_help.release_asset_candidates(SBSLIB)[0], SBSLIB)

    def test_mastlib_asks_for_the_canonical_name_first(self):
        self.assertEqual(file_help.release_asset_candidates(MASTLIB)[0], MASTLIB)

    def test_media_zip_asks_for_the_canonical_name_first(self):
        self.assertEqual(file_help.release_asset_candidates(MEDIA)[0], MEDIA)

    def test_mastlib_falls_back_to_the_old_bare_name(self):
        # Tags published before the workflow was fixed carry the bare addon name.
        self.assertEqual(file_help.release_asset_candidates(MASTLIB),
                         [MASTLIB, "consoles.v1.4.0.mastlib"])

    def test_sbslib_has_no_alternative_to_offer(self):
        # An sbslib is {user}.{package}.{version}.sbslib - only TWO segments precede the
        # version, so stripping the prefix would leave a bare "v1.4.0.sbslib".
        self.assertEqual(file_help.release_asset_candidates(SBSLIB), [SBSLIB])

    def test_unparseable_name_is_returned_as_is(self):
        self.assertEqual(file_help.release_asset_candidates("weird"), ["weird"])


def _zip_bytes():
    import io
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("x.mast", "# hi")
    return buf.getvalue()


class EnsureLibsFetchTests(unittest.TestCase):
    """_ensure_libs must ask for the PUBLISHED name and save under the LOCAL one."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mission = os.path.join(self.tmp.name, "mission")
        os.makedirs(self.mission)
        with open(os.path.join(self.mission, "story.json"), "w") as f:
            f.write('{"sbslib": [], "mastlib": ["%s"]}' % MASTLIB)
        # __lib__ is resolved relative to the missions dir, which is the mission's parent.
        self._missions = mock.patch.object(debug_cmd, "_missions_dir",
                                           return_value=self.tmp.name)
        self._missions.start()
        self.addCleanup(self._missions.stop)
        self.lib_dir = os.path.join(self.tmp.name, "__lib__")

    def _run(self, curl):
        with mock.patch.object(file_help, "curlretrieve", curl):
            debug_cmd._ensure_libs(self.mission, packaged_mode=False)

    def test_requests_the_canonical_name_and_saves_under_it(self):
        seen = []

        def curl(url, out):
            seen.append(url)
            with open(out, "wb") as f:
                f.write(_zip_bytes())
            return True

        self._run(curl)
        self.assertEqual(len(seen), 1, "the first candidate should have succeeded")
        self.assertTrue(seen[0].endswith("/" + MASTLIB), seen[0])
        self.assertIn("/artemis-sbs/LegendaryMissions/releases/download/v1.4.0/", seen[0])
        # ...but on disk it keeps the name story.json refers to.
        self.assertTrue(os.path.isfile(os.path.join(self.lib_dir, MASTLIB)))

    def test_falls_back_to_the_old_bare_name(self):
        seen = []

        def curl(url, out):
            seen.append(url)
            if url.endswith("/" + MASTLIB):
                raise RuntimeError("404")
            with open(out, "wb") as f:
                f.write(_zip_bytes())
            return True

        self._run(curl)
        self.assertEqual(len(seen), 2, "should have tried both conventions")
        self.assertTrue(seen[1].endswith("/consoles.v1.4.0.mastlib"), seen[1])
        self.assertTrue(os.path.isfile(os.path.join(self.lib_dir, MASTLIB)))

    def test_a_non_zip_response_never_lands_on_disk(self):
        def curl(url, out):
            with open(out, "wb") as f:
                f.write(b"<html>404</html>")
            return True

        with self.assertRaises(RuntimeError):
            self._run(curl)
        self.assertFalse(os.path.isfile(os.path.join(self.lib_dir, MASTLIB)))
        self.assertFalse(os.path.isfile(os.path.join(self.lib_dir, MASTLIB + ".download")))


class FetchDepsFailureTests(unittest.TestCase):
    """A dependency that never arrived must not read as a successful fetch.

    fetch_deps used to print an ERROR line into a wall of output and return nothing, so
    `sbs fetch` / `sbs production` carried on and exited 0 with libraries missing.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._cwd = os.getcwd()
        os.chdir(self.tmp.name)                 # fetch_deps writes to ./__lib__
        self.addCleanup(os.chdir, self._cwd)

    def test_reports_the_dependency_when_every_candidate_fails(self):
        def curl(url, out):
            raise RuntimeError("404")

        with mock.patch.object(file_help, "curlretrieve", curl):
            failed = file_help.fetch_deps([MASTLIB], False, True)
        self.assertEqual(failed, [MASTLIB])

    def test_a_non_archive_response_is_a_failure_not_a_lib(self):
        # curl -f still CREATES the output file on a 404; without the archive check that
        # HTML landed in __lib__ and the exists() skip treated it as already fetched.
        def curl(url, out):
            with open(out, "wb") as f:
                f.write(b"<html>Not Found</html>")
            return True

        with mock.patch.object(file_help, "curlretrieve", curl):
            failed = file_help.fetch_deps([MASTLIB], False, True)
        self.assertEqual(failed, [MASTLIB])
        self.assertFalse(os.path.exists(os.path.join("__lib__", MASTLIB)),
                         "a non-archive must never land in __lib__")

    def test_a_good_download_reports_nothing(self):
        def curl(url, out):
            with open(out, "wb") as f:
                f.write(_zip_bytes())
            return True

        with mock.patch.object(file_help, "curlretrieve", curl):
            failed = file_help.fetch_deps([MASTLIB], False, True)
        self.assertEqual(failed, [])
        self.assertTrue(os.path.isfile(os.path.join("__lib__", MASTLIB)))

    def test_report_missing_deps_signals_and_dedupes(self):
        import fetch_cmd
        self.assertFalse(fetch_cmd.report_missing_deps([]))
        self.assertTrue(fetch_cmd.report_missing_deps([MASTLIB, MASTLIB]))


if __name__ == "__main__":
    unittest.main()
