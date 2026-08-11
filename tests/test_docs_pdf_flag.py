"""`sbs docs --pdf` - the wiring, not the engine.

`pdf_out.render_pdf` is patched everywhere here, so no browser is ever launched.
What is under test is the decision-making around it: which engine, what happens
to `--assets`, and the refusals.

Patch where the name is LOOKED UP. `docs_cmd` imports `pdf_out` inside the
function, so `pdf_out.render_pdf` is the right target; patching a name in
`docs_cmd` would miss.
"""
import json
import os
import tempfile
import unittest
from unittest import mock

from click.testing import CliRunner

import docs_cmd
import pdf_out
from cli_cmd import cli

# `docs_cmd` resolves sbs_utils from the working tree beside the missions dir.
# The tests build their mission in a tmpdir, so point zipapp_dir at the real
# missions folder - otherwise every case fails on "No module named sbs_utils"
# and tests nothing about the flag it claims to test.
_MISSIONS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _needs_sbs_utils():
    return os.path.isdir(os.path.join(_MISSIONS, "sbs_utils"))

AMD = """\
# [The Reach](reach)
---
Display: The Reach
---
A ribbon of frontier stars.

## [Vex](vex)
---
Speaker: vex
---
![](face://arv #ffffff 0 0)
% Well met.
"""


def _mission(root, name="Demo", body=AMD):
    path = os.path.join(root, name)
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "story.json"), "w") as f:
        json.dump({"sbslib": []}, f)
    with open(os.path.join(path, "reach.amd"), "w", encoding="utf-8") as f:
        f.write(body)
    return path


class PdfFlagTests(unittest.TestCase):
    def setUp(self):
        if not _needs_sbs_utils():
            self.skipTest("sbs_utils working tree not beside sbs_cli")
        self._zip = mock.patch.object(docs_cmd, "zipapp_dir", _MISSIONS)
        self._zip.start()
        self.addCleanup(self._zip.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mission = _mission(self.tmp.name)
        self.runner = CliRunner()
        self.engine = pdf_out.Engine("chrome", "chrome.exe", "151.0.0.0")

        self.calls = []

        def fake_render(html, pdf, engine, timeout=90):
            self.calls.append({"html": html, "pdf": pdf, "engine": engine,
                               "timeout": timeout})
            with open(pdf, "wb") as f:
                f.write(b"%PDF-1.4" + b"x" * 4000)
            return True, ""

        self.render = mock.patch.object(pdf_out, "render_pdf", side_effect=fake_render)
        self.render.start()
        self.addCleanup(self.render.stop)
        self.choose = mock.patch.object(pdf_out, "choose_engine",
                                        return_value=(self.engine, "because"))
        self.choose.start()
        self.addCleanup(self.choose.stop)

    def run_docs(self, *args):
        return self.runner.invoke(cli, ["docs", self.mission, *args])

    def test_pdf_is_written_beside_the_html(self):
        res = self.run_docs("--lens", "prose", "--pdf")
        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.calls[0]["pdf"].endswith("Demo-prose.pdf"))
        self.assertTrue(os.path.isfile(
            os.path.join(self.mission, "__docs__", "Demo-prose.pdf")))

    def test_the_html_is_still_written(self):
        # It is the engine's input, and the thing you re-print.
        self.run_docs("--lens", "prose", "--pdf")
        self.assertTrue(os.path.isfile(
            os.path.join(self.mission, "__docs__", "Demo-prose.html")))

    def test_json_and_pdf_is_refused(self):
        res = self.run_docs("--lens", "prose", "--pdf", "--format", "json")
        self.assertEqual(res.exit_code, 2)
        self.assertIn("nothing to render", res.output)
        self.assertEqual(self.calls, [])

    def test_pdf_upgrades_the_assets_default(self):
        # A PDF is where art matters, and `link` costs nothing because the paths
        # are relative to __docs__, which is where the HTML lands.
        res = self.run_docs("--lens", "prose", "--pdf")
        self.assertIn("--assets link", res.output)

    def test_an_explicit_assets_choice_is_left_alone(self):
        res = self.run_docs("--lens", "prose", "--pdf", "--assets", "none")
        self.assertNotIn("using --assets link", res.output)

    def test_without_pdf_the_default_is_untouched(self):
        res = self.run_docs("--lens", "prose")
        self.assertNotIn("--assets link", res.output)
        self.assertEqual(self.calls, [])

    def test_timeout_reaches_the_engine(self):
        self.run_docs("--lens", "prose", "--pdf", "--pdf-timeout", "5")
        self.assertEqual(self.calls[0]["timeout"], 5)

    def test_one_pdf_per_lens(self):
        self.run_docs("--lens", "all", "--pdf")
        names = sorted(os.path.basename(c["pdf"]) for c in self.calls)
        self.assertEqual(names, ["Demo-bible.pdf", "Demo-catalog.pdf",
                                 "Demo-prose.pdf", "Demo-screenplay.pdf"])


class NoEngineTests(unittest.TestCase):
    def setUp(self):
        if not _needs_sbs_utils():
            self.skipTest("sbs_utils working tree not beside sbs_cli")
        self._zip = mock.patch.object(docs_cmd, "zipapp_dir", _MISSIONS)
        self._zip.start()
        self.addCleanup(self._zip.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mission = _mission(self.tmp.name)
        self.runner = CliRunner()

    def test_no_engine_exits_two_with_both_remedy_lines(self):
        with mock.patch.object(pdf_out, "choose_engine", return_value=(None, "none")):
            res = self.runner.invoke(cli, ["docs", self.mission, "--lens", "prose",
                                           "--pdf"])
        self.assertEqual(res.exit_code, 2)
        self.assertIn("no PDF engine found", res.output)
        self.assertIn("--browser", res.output)

    def test_an_engine_that_fails_exits_one(self):
        engine = pdf_out.Engine("chrome", "chrome.exe", "151")
        with mock.patch.object(pdf_out, "choose_engine", return_value=(engine, "x")), \
             mock.patch.object(pdf_out, "render_pdf",
                               return_value=(False, "chrome wrote no usable PDF")):
            res = self.runner.invoke(cli, ["docs", self.mission, "--lens", "prose",
                                           "--pdf"])
        self.assertEqual(res.exit_code, 1)
        self.assertIn("no usable PDF", res.output)


class WeasyprintFaceTests(unittest.TestCase):
    """weasyprint runs no JavaScript, so a canvas prints BLANK. A face-bearing
    document must be re-rendered with placeholders before it is handed over -
    otherwise the better typesetter produces the worse page, silently."""

    def setUp(self):
        if not _needs_sbs_utils():
            self.skipTest("sbs_utils working tree not beside sbs_cli")
        self._zip = mock.patch.object(docs_cmd, "zipapp_dir", _MISSIONS)
        self._zip.start()
        self.addCleanup(self._zip.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mission = _mission(self.tmp.name)
        self.runner = CliRunner()

    def test_a_placeholder_copy_is_fed_in_and_then_removed(self):
        engine = pdf_out.Engine("weasyprint", "weasyprint", "62")
        seen = {}

        def fake_render(html, pdf, eng, timeout=90):
            seen["html"] = html
            seen["existed"] = os.path.isfile(html)
            with open(pdf, "wb") as f:
                f.write(b"%PDF-1.4" + b"x" * 4000)
            return True, ""

        # `--assets embed` so the resolver offers face sheets and the canvas path
        # is genuinely reachable, which is what makes this case real.
        with mock.patch.object(pdf_out, "choose_engine", return_value=(engine, "x")), \
             mock.patch.object(pdf_out, "render_pdf", side_effect=fake_render):
            res = self.runner.invoke(cli, ["docs", self.mission, "--lens", "prose",
                                           "--pdf", "--assets", "embed"])
        self.assertEqual(res.exit_code, 0, res.output)
        if seen.get("html", "").endswith(".print.html"):
            self.assertTrue(seen["existed"], "the copy must exist when handed over")
            self.assertFalse(os.path.isfile(seen["html"]),
                             "the temporary copy must be cleaned up")
            self.assertIn("no JavaScript", res.output)


if __name__ == "__main__":
    unittest.main()
