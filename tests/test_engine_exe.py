"""`--debug` / `--exe` pick which engine build `sbs run` and `sbs art bake` launch."""
import os
import tempfile
import unittest
from unittest import mock

import click

from engine_exe import resolve_engine_exe, RELEASE_EXE, DEBUG_EXE


class ResolveEngineExeTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        for name in (RELEASE_EXE, DEBUG_EXE, "Artemis3-x64-release-1.3.4.exe"):
            open(os.path.join(self.root, name), "w").close()
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        os.environ.pop("SBS_ENGINE_EXE", None)
        self.addCleanup(env.stop)

    def tearDown(self):
        self._tmp.cleanup()

    def _is(self, path, name):
        self.assertEqual(os.path.normcase(path),
                         os.path.normcase(os.path.join(self.root, name)))

    def test_default_is_release(self):
        self._is(resolve_engine_exe(self.root), RELEASE_EXE)

    def test_debug_flag(self):
        self._is(resolve_engine_exe(self.root, debug=True), DEBUG_EXE)

    def test_short_form(self):
        self._is(resolve_engine_exe(self.root, exe="release-1.3.4"),
                 "Artemis3-x64-release-1.3.4.exe")
        self._is(resolve_engine_exe(self.root, exe="debug"), DEBUG_EXE)

    def test_file_name_in_install(self):
        self._is(resolve_engine_exe(self.root, exe=DEBUG_EXE), DEBUG_EXE)

    def test_absolute_path(self):
        path = os.path.join(self.root, DEBUG_EXE)
        self._is(resolve_engine_exe("C:\\nowhere", exe=path), DEBUG_EXE)

    def test_result_is_absolute(self):
        self.assertTrue(os.path.isabs(resolve_engine_exe(self.root, debug=True)))

    def test_both_is_an_error(self):
        with self.assertRaises(click.ClickException):
            resolve_engine_exe(self.root, debug=True, exe="release")

    def test_missing_lists_what_is_installed(self):
        with self.assertRaises(click.ClickException) as cm:
            resolve_engine_exe(self.root, exe="release-9.9")
        self.assertIn("release-1.3.4", cm.exception.message)

    def test_env_var_applies_when_no_flag(self):
        os.environ["SBS_ENGINE_EXE"] = "debug"
        self._is(resolve_engine_exe(self.root), DEBUG_EXE)

    def test_flag_beats_env_var(self):
        os.environ["SBS_ENGINE_EXE"] = "release-1.3.4"
        self._is(resolve_engine_exe(self.root, debug=True), DEBUG_EXE)
        self._is(resolve_engine_exe(self.root, exe="release"), RELEASE_EXE)


if __name__ == "__main__":
    unittest.main()
