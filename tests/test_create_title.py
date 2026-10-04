"""`sbs create --title` must never write a description.yaml that stops the game starting.

A bare hyphen anywhere in a description.yaml value crashes the engine's mission-list scan
at start-up - for every launch, whatever mission is asked for, with nothing in any log.
`sbs create MyMission --title "Half-Light"` wrote exactly that. One writer's first mission
would have stopped the game opening at all, and nothing would have said why.
"""
import pathlib
import tempfile
import unittest

import create_cmd

TEMPLATE = (
    "format version: 1\n"
    "# Name of the mission as it appears in the mission list\n"
    "Visible Mission Name: AMD Sample   # shown in the list\n"
    "Description: A short investigation.\n"
)


class TitleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = pathlib.Path(self.tmp.name) / "description.yaml"
        self.path.write_text(TEMPLATE, encoding="utf-8")

    def lines(self):
        return self.path.read_text(encoding="utf-8").splitlines()

    def test_a_hyphen_is_quoted(self):
        create_cmd._rewrite_line(self.path, "Visible Mission Name", "Half-Light")
        self.assertIn('Visible Mission Name: "Half-Light"  # shown in the list', self.lines())

    def test_a_plain_title_is_written_as_it_is(self):
        create_cmd._rewrite_line(self.path, "Description", "The Kestrel Verge")
        self.assertIn("Description: The Kestrel Verge", self.lines())

    def test_the_comments_survive(self):
        create_cmd._rewrite_line(self.path, "Visible Mission Name", "Half-Light")
        self.assertIn("# Name of the mission as it appears in the mission list", self.lines())

    def test_a_double_quote_is_refused(self):
        self.assertIsNotNone(create_cmd._bad_title('The "Verge"'))

    def test_a_hyphen_is_allowed(self):
        self.assertIsNone(create_cmd._bad_title("Half-Light"))


if __name__ == "__main__":
    unittest.main()
