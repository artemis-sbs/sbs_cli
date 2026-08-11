"""`sbs deps` - the sidecar. pip is never actually run here.

The thing worth remembering about this feature is WHY it has to exist: `sbs`
runs on the embedded CPython, whose `python311._pth` disables `site`, so
`site-packages` is off `sys.path`, `PYTHONPATH` is ignored, and `python -m pip`
reports "No module named pip" while pip sits right there in the runtime. The
`_PIP_BOOT` string is the whole fix, and these tests pin its shape.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import cli_cmd
import deps_cmd


class SidecarPathTests(unittest.TestCase):
    def test_sidecar_is_appended_never_inserted(self):
        # compile_cmd INSERTS PyAddons at the front because ryaml must beat the
        # bundled yaml. This is the opposite case: a stray `click` in the sidecar
        # must never shadow the one sbs ships with and needs to start at all.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        side = os.path.join(tmp.name, cli_cmd.SIDECAR)
        os.makedirs(side)
        before = list(sys.path)
        with mock.patch.object(cli_cmd, "zipapp_dir", tmp.name):
            cli_cmd._add_sidecar()
            self.assertEqual(sys.path[-1], side)
        sys.path[:] = before

    def test_a_missing_sidecar_is_silent(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        before = list(sys.path)
        with mock.patch.object(cli_cmd, "zipapp_dir", tmp.name):
            cli_cmd._add_sidecar()
        self.assertEqual(sys.path, before)

    def test_engine_dir_finds_the_cosmos_root_not_a_fixed_depth(self):
        # Counting `..` is only right when zipapp_dir is the missions folder.
        # From source it is sbs_cli/, one deeper, and the count lands on
        # data/PyAddons - a folder that does not exist.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = os.path.join(tmp.name, "Cosmos")
        os.makedirs(os.path.join(root, "PyRuntime"))
        deep = os.path.join(root, "data", "missions", "sbs_cli")
        os.makedirs(deep)
        for start in (os.path.join(root, "data", "missions"), deep):
            with mock.patch.object(deps_cmd, "zipapp_dir", start):
                self.assertEqual(deps_cmd.engine_dir(),
                                 os.path.join(root, "PyAddons"))


class SitePackagesTests(unittest.TestCase):
    def test_validated_by_isdir_not_by_import(self):
        # A failed import walks the whole of sys.path - the cost
        # fs.ryaml_module() documents paying once and caching.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        good = os.path.join(tmp.name, "Lib", "site-packages")
        os.makedirs(os.path.join(good, "pip"))
        with mock.patch.object(sys, "base_prefix", tmp.name), \
             mock.patch.dict(sys.modules, {"pip": None}):
            self.assertEqual(deps_cmd.site_packages(), good)

    def test_none_when_pip_is_nowhere(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with mock.patch.object(sys, "base_prefix", tmp.name), \
             mock.patch.object(sys, "executable",
                               os.path.join(tmp.name, "python.exe")), \
             mock.patch.dict(sys.modules, {"pip": None}), \
             mock.patch("sysconfig.get_paths", return_value={"purelib": tmp.name}):
            self.assertIsNone(deps_cmd.site_packages())


class InstallTests(unittest.TestCase):
    def setUp(self):
        from click.testing import CliRunner
        self.runner = CliRunner()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.side = os.path.join(self.tmp.name, "__pylib__")
        self._s = mock.patch.object(deps_cmd, "sidecar_dir", lambda: self.side)
        self._s.start()
        self.addCleanup(self._s.stop)
        self._sp = mock.patch.object(deps_cmd, "site_packages",
                                     return_value=r"C:\py\Lib\site-packages")
        self._sp.start()
        self.addCleanup(self._sp.stop)

    def invoke(self, *args):
        from cli_cmd import cli
        return self.runner.invoke(cli, ["deps", *args])

    def test_pip_is_driven_through_this_interpreter(self):
        seen = {}

        def fake(argv, env=None, **kw):
            seen["argv"], seen["env"] = argv, env
            return 0

        with mock.patch.object(subprocess, "call", side_effect=fake):
            res = self.invoke("install", "pypdf")
        self.assertEqual(res.exit_code, 0, res.output)
        argv = seen["argv"]
        # The SAME interpreter, so pip resolves wheels for the real 3.11 ABI.
        self.assertEqual(argv[0], sys.executable)
        self.assertEqual(argv[1], "-c")
        self.assertIn("SBS_PIP_SITE", argv[2])
        self.assertEqual(argv[3:], ["install", "--target", self.side,
                                    "--upgrade", "pypdf"])
        # env, because PYTHONPATH is ignored on this interpreter.
        self.assertEqual(seen["env"]["SBS_PIP_SITE"], r"C:\py\Lib\site-packages")

    def test_upgrade_is_always_passed(self):
        # `--target` without it errors on an already-present package.
        with mock.patch.object(subprocess, "call", return_value=0) as call:
            self.invoke("install", "pypdf")
        self.assertIn("--upgrade", call.call_args[0][0])

    def test_a_native_backed_package_is_refused_before_pip_runs(self):
        # weasyprint installs cleanly and then cannot import. This is the single
        # most likely thing for someone to try.
        with mock.patch.object(subprocess, "call",
                               side_effect=AssertionError("ran pip")):
            res = self.invoke("install", "weasyprint")
        self.assertEqual(res.exit_code, 2)
        self.assertIn("GTK", res.output)
        self.assertIn("appear to succeed", res.output)

    def test_no_pip_exits_two_with_a_remedy(self):
        with mock.patch.object(deps_cmd, "site_packages", return_value=None):
            res = self.invoke("install", "pypdf")
        self.assertEqual(res.exit_code, 2)
        self.assertIn("not reachable", res.output)

    def test_pip_failure_exits_one(self):
        with mock.patch.object(subprocess, "call", return_value=1):
            res = self.invoke("install", "pypdf")
        self.assertEqual(res.exit_code, 1)

    def test_engine_target_asks_first(self):
        # It writes into the Cosmos install and makes a mission non-portable.
        with mock.patch.object(deps_cmd, "engine_dir",
                               lambda: os.path.join(self.tmp.name, "PyAddons")), \
             mock.patch.object(subprocess, "call",
                               side_effect=AssertionError("ran pip")):
            res = self.invoke("install", "pypdf", "--engine")
        self.assertEqual(res.exit_code, 1)
        self.assertIn("no", res.output.lower())
        self.assertIn("self-contained", res.output)

    def test_engine_target_is_a_different_folder(self):
        engine = os.path.join(self.tmp.name, "PyAddons")
        with mock.patch.object(deps_cmd, "engine_dir", lambda: engine), \
             mock.patch.object(subprocess, "call", return_value=0) as call:
            self.invoke("install", "pypdf", "--engine", "--yes")
        argv = call.call_args[0][0]
        self.assertIn(engine, argv)
        self.assertNotIn(self.side, argv)


class ListAndRemoveTests(unittest.TestCase):
    def setUp(self):
        from click.testing import CliRunner
        self.runner = CliRunner()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.side = os.path.join(self.tmp.name, "__pylib__")
        os.makedirs(os.path.join(self.side, "pypdf"))
        info = os.path.join(self.side, "pypdf-6.15.0.dist-info")
        os.makedirs(info)
        with open(os.path.join(info, "RECORD"), "w") as f:
            f.write("pypdf/__init__.py,sha256=x,1\n"
                    "pypdf-6.15.0.dist-info/RECORD,,\n")
        os.makedirs(os.path.join(self.side, "decoy"))
        self._s = mock.patch.object(deps_cmd, "sidecar_dir", lambda: self.side)
        self._s.start()
        self.addCleanup(self._s.stop)

    def invoke(self, *args):
        from cli_cmd import cli
        return self.runner.invoke(cli, ["deps", *args])

    def test_list_reads_versions_from_dist_info(self):
        res = self.invoke("list")
        self.assertIn("pypdf 6.15.0", res.output)
        self.assertIn("no cross-install resolution", res.output)

    def test_remove_takes_only_that_package(self):
        res = self.invoke("remove", "pypdf")
        self.assertEqual(res.exit_code, 0, res.output)
        self.assertFalse(os.path.exists(os.path.join(self.side, "pypdf")))
        self.assertTrue(os.path.isdir(os.path.join(self.side, "decoy")))

    def test_removing_what_is_not_there_exits_one(self):
        self.assertEqual(self.invoke("remove", "nope").exit_code, 1)


if __name__ == "__main__":
    unittest.main()
