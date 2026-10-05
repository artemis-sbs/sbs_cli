"""`sbs lint` reads description.yaml, the one file that can stop the GAME starting.

The server reads every mission's description.yaml to build its list before any mission
runs, and a bare hyphen in a value crashes that scan: no mission starts, nothing is
logged (measured in the engine, 2026-09-20). The capstone lesson is where a writer first
edits that file by hand - `Visible Mission Name: The Half-Dark Lantern` - and then mails
the mission to a friend. Lint said `clean` and doctor `0 problems`.
"""
import os
import tempfile
import unittest

import lint_cmd

GOOD = (
    "#Every mission should have this file included.  It describes the mission - for the list.\n"
    "format version: 1\n"
    "Category: Standard\n"
    "Category Priority: B\n"
    "Visible Mission Name: The Quiet Lantern   # shown in the list - keep it short\n"
    "Description: A dark beacon, a missing keeper, and a storm ten minutes out.\n"
    "Keywords: standard, story\n"
)


class _Mission(unittest.TestCase):
    def findings(self, text):
        with tempfile.TemporaryDirectory() as mission:
            with open(os.path.join(mission, "description.yaml"), "w", encoding="utf-8") as f:
                f.write(text)
            return lint_cmd._description_yaml_findings(mission)


class WhatIsSafe(_Mission):
    def test_the_template_as_a_writer_leaves_it(self):
        self.assertEqual(self.findings(GOOD), [])

    def test_a_hyphen_in_quote_marks(self):
        self.assertEqual(self.findings(GOOD.replace("The Quiet Lantern",
                                                    '"The Half-Dark Lantern"')), [])

    def test_a_hyphen_in_a_comment_only(self):
        self.assertEqual(self.findings("# a note - with a hyphen\nCategory: Standard  # a-b\n"), [])

    def test_no_file_at_all(self):
        with tempfile.TemporaryDirectory() as mission:
            self.assertEqual(lint_cmd._description_yaml_findings(mission), [])


class WhatStopsTheGame(_Mission):
    def test_a_bare_hyphen_in_the_name(self):
        got = self.findings(GOOD.replace("The Quiet Lantern", "The Half-Dark Lantern"))
        self.assertEqual([n for n, _ in got], [5])
        self.assertIn("stops the GAME from starting", got[0][1])
        self.assertIn('Visible Mission Name: "The Half-Dark Lantern"', got[0][1])

    def test_a_bare_hyphen_in_the_description(self):
        got = self.findings(GOOD.replace("a storm ten minutes out", "a storm - ten minutes out"))
        self.assertEqual([n for n, _ in got], [6])

    def test_a_second_colon(self):
        got = self.findings(GOOD.replace("The Quiet Lantern", "Salvage: The Lantern"))
        self.assertEqual([n for n, _ in got], [5])
        self.assertIn("second colon", got[0][1])


if __name__ == "__main__":
    unittest.main()
