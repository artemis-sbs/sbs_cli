"""`sbs docs` end to end: the printed fields are in the WRITER's words.

The renderer is sbs_utils' `amd_render`; this drives the real command against the
working tree beside sbs_cli, so it fails if the command ever stops reaching it. Found
by the C1-12 pilot: `Goal` / `When` / `Parent` / `Scan_Of` where the writer typed
`Done when:` / `Starts when:` / `Part of:` / `Scan of:`, `Win False` for a `Win:`
sentence, and a hail slugged OUTGOING.
"""
import json
import os
import re
import tempfile
import unittest
from unittest import mock

from click.testing import CliRunner

import docs_cmd
from cli_cmd import cli

_MISSIONS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

AMD = """\
# [Quests](quests)

## [Find the Hulk](find_hulk)
---
Starts when: at once
Done when: reach hulk 2000
Win: The hulk is found and the crew comes home.
---
Fly out and find the hulk.

## [Step Two](step_two)
---
Part of: find_hulk
Done when: signal step_done
---
A step.

# [Scans](scans)

## [Hulk Scan](hulk_scan)
---
Scan of: hulk
Tab: scan
---
% Cold metal.

# [Dialogue](dialogue)

## [Captain Calls](captain_call)
---
Speaker: captain_call
When: hail
---
% We need help.
"""


class DocsAuthoredLabels(unittest.TestCase):
    def setUp(self):
        if not os.path.isdir(os.path.join(_MISSIONS, "sbs_utils")):
            self.skipTest("sbs_utils working tree not beside sbs_cli")
        self._zip = mock.patch.object(docs_cmd, "zipapp_dir", _MISSIONS)
        self._zip.start()
        self.addCleanup(self._zip.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mission = os.path.join(self.tmp.name, "Demo")
        os.makedirs(self.mission)
        with open(os.path.join(self.mission, "story.json"), "w") as f:
            json.dump({"sbslib": []}, f)
        with open(os.path.join(self.mission, "mission.amd"), "w", encoding="utf-8") as f:
            f.write(AMD)

    def page(self, lens):
        res = CliRunner().invoke(cli, ["docs", self.mission, "--lens", lens])
        self.assertEqual(res.exit_code, 0, res.output)
        path = os.path.join(self.mission, "__docs__", f"Demo-{lens}.html")
        with open(path, encoding="utf-8") as f:
            return f.read()

    def test_catalog_labels_are_as_typed(self):
        labels = re.findall(r"<dt>([^<]*)</dt>", self.page("catalog"))
        for typed in ("Starts when", "Done when", "Part of", "Scan of", "Win"):
            self.assertIn(typed, labels)
        for stored in ("Goal", "Parent", "Scan_Of", "Scan Of"):
            self.assertNotIn(stored, labels)

    def test_win_keeps_its_sentence(self):
        page = self.page("catalog")
        self.assertIn("The hulk is found and the crew comes home.", page)
        self.assertNotIn("False", page)

    def test_a_hail_is_incoming(self):
        page = self.page("screenplay")
        self.assertIn("INT. COMMS - INCOMING", page)
        self.assertNotIn("OUTGOING", page)


if __name__ == "__main__":
    unittest.main()
