"""A fetch must never destroy a git checkout.

`fetch_cmd` rmtree's the whole mission folder before unzipping, and a dev tree keeps its
clones at exactly the paths fetch targets (`data/missions/LegendaryMissions`, ...). That
took uncommitted work, stashes and local branches with it, with no undo and only a generic
"This will remove the existing folder(s)" prompt. `sbs fetch --source` makes clones at
those paths the documented workflow, so the hazard had to go first.

The rule is recoverable vs. not: refuse to DELETE a checkout, but only warn when
`--skip_clean` unzips over one, since `git checkout .` undoes that.
"""
import os
import tempfile
import unittest
from unittest import mock

import fetch_cmd


def _make_clone(path):
    """A folder that looks like a checkout, plus a file that must survive."""
    os.makedirs(os.path.join(path, ".git"), exist_ok=True)
    with open(os.path.join(path, "precious.mast"), "w") as f:
        f.write("# uncommitted work\n")


class GitGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._zipapp = mock.patch.object(fetch_cmd, "zipapp_dir", self.tmp.name)
        self._zipapp.start()
        self.addCleanup(self._zipapp.stop)
        self.target = os.path.join(self.tmp.name, "LegendaryMissions")

    def _curl_must_not_run(self, *a, **k):
        raise AssertionError("must not download before deciding to skip")

    def test_is_clone(self):
        os.makedirs(self.target)
        self.assertFalse(fetch_cmd.is_clone(self.target))
        os.makedirs(os.path.join(self.target, ".git"))
        self.assertTrue(fetch_cmd.is_clone(self.target))

    def test_refuses_to_delete_a_checkout_and_reports_it(self):
        _make_clone(self.target)
        with mock.patch.object(fetch_cmd, "curlretrieve", self._curl_must_not_run):
            missing, skipped = fetch_cmd.fetch_cmd(
                "LegendaryMissions", "artemis-sbs", "main", None,
                False, False, False, False)
        self.assertEqual(skipped, ["LegendaryMissions"])
        self.assertEqual(missing, [])
        self.assertTrue(os.path.isdir(os.path.join(self.target, ".git")), ".git survived")
        self.assertTrue(os.path.isfile(os.path.join(self.target, "precious.mast")),
                        "uncommitted work survived")

    def test_a_plain_folder_is_still_fetched(self):
        os.makedirs(self.target)          # not a checkout
        with mock.patch.object(fetch_cmd, "curlretrieve", lambda *a, **k: False):
            missing, skipped = fetch_cmd.fetch_cmd(
                "LegendaryMissions", "artemis-sbs", "main", None,
                False, False, False, False)
        # The download fails (mocked), but it got PAST the guard - which is the point.
        self.assertEqual(skipped, [])

    def test_skip_clean_warns_but_proceeds(self):
        # Unzipping over a checkout only dirties tracked files; `git checkout .` undoes it.
        _make_clone(self.target)
        calls = []
        with mock.patch.object(fetch_cmd, "curlretrieve",
                               lambda *a, **k: calls.append(a) or False):
            missing, skipped = fetch_cmd.fetch_cmd(
                "LegendaryMissions", "artemis-sbs", "main", None,
                False, False, True, False)     # skip_clean=True
        self.assertEqual(skipped, [], "--skip_clean must not skip the repo")
        self.assertTrue(calls, "it should have gone on to download")
        self.assertTrue(os.path.isdir(os.path.join(self.target, ".git")))

    def test_source_on_an_existing_clone_reports_instead_of_cloning(self):
        _make_clone(self.target)
        with mock.patch("subprocess.run",
                        side_effect=AssertionError("must not clone over a checkout")):
            missing, skipped = fetch_cmd.fetch_cmd(
                "LegendaryMissions", "artemis-sbs", "main", None,
                False, False, False, False, source=True)
        self.assertEqual(skipped, ["LegendaryMissions"])
        self.assertTrue(os.path.isfile(os.path.join(self.target, "precious.mast")))

    def test_one_clone_does_not_stop_the_other_missions(self):
        _make_clone(self.target)
        seen = []

        def fake(repo, *a, **k):
            seen.append(repo)
            return ([], [])

        with mock.patch.object(fetch_cmd, "fetch_cmd", side_effect=fake) as _:
            missing, skipped = fetch_cmd.fetch_repos(
                "LegendaryMissions,SecretMeeting", "artemis-sbs", "main", None,
                False, False, False, False)
        self.assertEqual(seen, ["LegendaryMissions", "SecretMeeting"],
                         "the loop must continue past a skipped repo")

    def test_source_reports_when_git_is_missing(self):
        with mock.patch("subprocess.run", side_effect=FileNotFoundError()):
            missing, skipped = fetch_cmd.fetch_cmd(
                "LegendaryMissions", "artemis-sbs", "main", None,
                False, False, False, False, source=True)
        self.assertEqual(skipped, ["LegendaryMissions"])


if __name__ == "__main__":
    unittest.main()
