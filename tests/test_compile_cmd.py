"""`sbs compile` - guards against the way it broke.

It was broken for every user, in its default mode, from 2026-06-19 to 2026-08-11.
`compile_cmd` imported `sbs_utils.mock`; that package became `cosmos_dev.mock` in
the sibling repo and nothing here was updated. Nobody noticed because:

* the failure arrived as a bare `No module named 'sbs_utils.mock'` with no file and
  no line, from an `except Exception: print(e)` that discarded the traceback;
* `--terminal` takes a different branch and kept working, so the one documented
  workaround existed by accident;
* **no CI ran these tests**, and this repo's only workflow builds a release.

These are cheap source-level assertions on purpose. The real thing they defend
against is a rename in ANOTHER repository, which no amount of unit-testing this one
can observe - so they pin the name, and the dynamic check runs only where the
sibling is actually present.
"""
import ast
import os
import re
import unittest

import compile_cmd

_SRC = os.path.dirname(os.path.abspath(compile_cmd.__file__))
_MISSIONS = os.path.abspath(os.path.join(_SRC, "..", ".."))


def source_of(name):
    with open(os.path.join(_SRC, name), encoding="utf-8") as f:
        return f.read()


class TestTheStaleImportCannotComeBack(unittest.TestCase):
    def test_no_module_in_src_IMPORTS_sbs_utils_mock(self):
        # The package has not existed since 2026-06-19. Checked against parsed
        # IMPORT statements rather than the file text: the history is worth
        # writing down in comments, and a test that cannot tell an explanation
        # from an instruction makes the code harder to explain.
        for entry in sorted(os.listdir(_SRC)):
            if not entry.endswith(".py"):
                continue
            with self.subTest(module=entry):
                for node in ast.walk(ast.parse(source_of(entry))):
                    # Import nodes only. `ast.Global` also carries `names`, but of
                    # plain strings, so a looser walk crashes on `global _X`.
                    if not isinstance(node, (ast.Import, ast.ImportFrom)):
                        continue
                    mod = getattr(node, "module", None) or ""
                    names = [a.name for a in node.names]
                    self.assertFalse(
                        mod.startswith("sbs_utils.mock")
                        or any(n.startswith("sbs_utils.mock") for n in names),
                        "sbs_utils.mock became cosmos_dev.mock")

    def test_compile_imports_the_mock_from_cosmos_dev(self):
        self.assertIn("from cosmos_dev.mock import sbs", source_of("compile_cmd.py"))

    @unittest.skipUnless(os.path.isdir(os.path.join(_MISSIONS, "sbs_utils")),
                         "sbs_utils working tree not beside sbs_cli")
    def test_the_module_it_imports_actually_exists(self):
        # The assertion above pins a string; this one checks reality, wherever the
        # sibling repo is available to be checked.
        self.assertTrue(os.path.isfile(os.path.join(
            _MISSIONS, "sbs_utils", "cosmos_dev", "mock", "sbs.py")))
        self.assertFalse(os.path.isdir(os.path.join(
            _MISSIONS, "sbs_utils", "sbs_utils", "mock")))


class TestTheMockStaysOnTheSharedPath(unittest.TestCase):
    """The import looks dead on the compile path and is not.

    While fixing this I moved it into the `--run` branch, reasoning that `sbs` is
    only referenced by `sbs.create_new_sim()`. That broke compilation a different
    way: importing `cosmos_dev.mock.sbs` registers `sys.modules["sbs"]`, and
    library code compiled below does a bare `import sbs`. The import is load-bearing
    for its SIDE EFFECT."""

    def test_it_is_imported_before_the_compile_only_return(self):
        src = source_of("compile_cmd.py")
        mock_at = src.index("from cosmos_dev.mock import sbs")
        # `if compile_only:` is the branch a plain `sbs compile` returns from.
        branch_at = src.index("if compile_only:")
        self.assertLess(mock_at, branch_at,
                        "the mock must be imported before the compile-only branch "
                        "returns, or library code cannot `import sbs`")

    def test_story_nodes_is_imported_after_the_mock(self):
        src = source_of("compile_cmd.py")
        self.assertLess(src.index("from cosmos_dev.mock import sbs"),
                        src.index("import sbs_utils.mast_sbs.story_nodes"))


class TestEnvironmentSetup(unittest.TestCase):
    def test_compile_sets_the_fs_paths(self):
        # Without exe_dir, `fs` falls back to the directory of sys.executable -
        # PyRuntime - and every library path resolves under it, so a mission that
        # compiles fine reports every mastlib missing. The --terminal branch always
        # set these; the default branch did not, because it never got far enough
        # to need them.
        src = source_of("compile_cmd.py")
        self.assertEqual(src.count("fs.exe_dir = exe_path"), 2,
                         "both compile branches must set fs.exe_dir")

    def test_compile_prefers_the_working_tree(self):
        # Otherwise compile checks the RELEASED sbslib while lint checks your
        # edits, and the two disagree about the same mission with nothing to say
        # why. Importing it - not merely pathing it - is what wins the race against
        # PyAddons/sbslibs.py, which inserts the .sbslib at sys.path[0] afterwards.
        src = source_of("compile_cmd.py")
        self.assertIn("_prefer_working_tree_sbs_utils", src)
        self.assertLess(src.index("_prefer_working_tree_sbs_utils"),
                        src.index("import script"))

    def test_it_parses(self):
        ast.parse(source_of("compile_cmd.py"))


class TestErrorReporting(unittest.TestCase):
    def test_the_traceback_is_not_unconditionally_discarded(self):
        # `except Exception as e: print(e)` is why a two-month-old breakage read as
        # a bare "No module named ..." with nothing to locate it.
        src = source_of("compile_cmd.py")
        self.assertIn("traceback", src)
        self.assertFalse(re.search(r"except Exception as e:\s*\n\s*print\s*\(\s*e\s*\)\s*\n\s*return False",
                                   src),
                         "the bare print-and-swallow handler is back")


if __name__ == "__main__":
    unittest.main()
