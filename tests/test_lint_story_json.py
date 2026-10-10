"""A `story.json` that is not JSON is ONE finding, about `story.json`.

Found by Class 5, Lecture 10 of the author course. The lesson adds two lines to
`story.json`; with the comma left off the first, `sbs lint` printed fifty-four warnings
about a correct `.amd` (the mission's own words had not been loaded, nor its addons'
routes) and then `story.mast (compile) line 1` - the wrong file and the wrong line.
"""
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout

from click.testing import CliRunner

import lint_cmd

GOOD = '''{
    "sbslib": [
        "artemis-sbs.sbs_utils.v1.4.0.sbslib"
    ],
    "mastlib": [
        "artemis-sbs.LegendaryMissions.boarding.v1.4.0.mastlib",
        "artemis-sbs.OpenUniverse.universe_core.v1.4.0.mastlib"
    ]
}
'''
# The lesson's own slip: the comma left off the end of the first of two lines.
NO_COMMA = GOOD.replace('boarding.v1.4.0.mastlib",', 'boarding.v1.4.0.mastlib"')
# And the other one: a comma after the last line of the list.
ONE_TOO_MANY = GOOD.replace('universe_core.v1.4.0.mastlib"', 'universe_core.v1.4.0.mastlib",')

AMD = """# [The Kestrel Verge](kestrel_verge)
---
Universe
---

## [Narrative](narrative)

### [The Ledger](tern_ledger)
---
Starts when: at once
Done when: signal ledger_read
---
Somebody has to read it.
"""


class _Mission(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mission = os.path.join(self.tmp.name, "MyUniverse")
        os.makedirs(self.mission)
        with open(os.path.join(self.mission, "kestrel_verge.amd"), "w", newline="\n") as f:
            f.write(AMD)
        with open(os.path.join(self.mission, "story.mast"), "w", newline="\n") as f:
            f.write("# nothing\n")

    def story(self, text):
        with open(os.path.join(self.mission, "story.json"), "w", newline="\n") as f:
            f.write(text)

    def lint(self, *args):
        return CliRunner().invoke(lint_cmd.lint, [self.mission, *args])


class WhatIsWrongWithIt(_Mission):
    def test_a_good_file_says_nothing(self):
        self.story(GOOD)
        self.assertIsNone(lint_cmd._story_json_error(self.mission))

    def test_no_file_at_all_says_nothing(self):
        self.assertIsNone(lint_cmd._story_json_error(self.mission))

    def test_THE_MISSING_COMMA_NAMES_THE_FILE_AND_THE_LINE(self):
        self.story(NO_COMMA)
        number, message = lint_cmd._story_json_error(self.mission)
        self.assertEqual(number, 7)                 # the line after the one to fix
        self.assertIn("`story.json` cannot be read", message)
        self.assertIn("line 7", message)
        self.assertIn("comma missing from the end of the line above", message)
        self.assertIn("the mission does not start", message)

    def test_a_comma_too_many_says_so(self):
        self.story(ONE_TOO_MANY)
        number, message = lint_cmd._story_json_error(self.mission)
        # Where the reader gives up depends on the Python: on the comma (3.13 and
        # later), or on the bracket under it.
        self.assertIn(number, (7, 8))
        self.assertIn("comma after the LAST line", message)

    def test_a_file_saved_with_a_mark_in_front_is_still_read(self):
        with open(os.path.join(self.mission, "story.json"), "w", encoding="utf-8-sig") as f:
            f.write(GOOD)
        self.assertIsNone(lint_cmd._story_json_error(self.mission))


class TheCommandSaysOneThingAndStops(_Mission):
    def test_ONE_FINDING_AND_NOTHING_ABOUT_ANY_OTHER_FILE(self):
        self.story(NO_COMMA)
        result = self.lint()
        self.assertEqual(result.exit_code, 1)
        out = result.output
        self.assertIn("== story.json ==", out)
        self.assertIn("(story-json)", out)
        self.assertIn("Nothing else was checked", out)
        self.assertNotIn("kestrel_verge.amd", out)
        self.assertNotIn("story.mast", out)
        self.assertNotIn("mast-compile", out)
        self.assertEqual(out.count("[ERROR]"), 1)
        self.assertNotIn("[WARNING]", out)

    def test_the_compact_line_an_editor_reads(self):
        self.story(NO_COMMA)
        result = self.lint("--format", "compact")
        self.assertEqual(result.exit_code, 1)
        lines = [l for l in result.output.splitlines() if l.strip()]
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("story.json:7:1: error: "), lines[0])
        self.assertTrue(lines[0].endswith("[story-json]"), lines[0])

    def test_json_is_one_record(self):
        self.story(NO_COMMA)
        result = self.lint("--format", "json")
        self.assertEqual(result.exit_code, 1)
        got = json.loads(result.output)
        self.assertEqual([(g["file"], g["line"], g["code"], g["severity"]) for g in got],
                         [("story.json", 7, "story-json", "error")])


if __name__ == "__main__":
    unittest.main()
