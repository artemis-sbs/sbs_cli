"""PDF engine discovery and invocation. No browser is ever launched here.

Two things in this module look like over-engineering until you know why:

  * **`shutil.which` is the LAST resort, not the first.** On Windows - the
    platform the tool is built for - Chrome and Edge live under Program Files and
    are not on PATH. A `which`-first probe reports "no browser" on a machine with
    two of them.
  * **The exit code is not evidence.** Headless Chrome exits 0 having written
    nothing, and a browser handed a path it cannot open prints its own "file not
    found" page - a perfectly valid one-page PDF. Only the artifact counts.
"""
import os
import subprocess
import tempfile
import unittest
from unittest import mock

import pdf_out


def _fake_install(root, rel, version="151.0.7922.76"):
    """A browser tree: the exe plus the numbered sibling directory the version is
    read from."""
    exe = os.path.join(root, rel)
    app = os.path.dirname(exe)
    os.makedirs(os.path.join(app, version), exist_ok=True)
    with open(exe, "w") as f:
        f.write("")
    return exe


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = mock.patch.dict(os.environ, {
            "PROGRAMFILES": os.path.join(self.tmp.name, "pf"),
            "PROGRAMFILES(X86)": os.path.join(self.tmp.name, "pf86"),
            "LOCALAPPDATA": os.path.join(self.tmp.name, "lad"),
        }, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        os.environ.pop("SBS_BROWSER", None)

    def test_finds_chrome_and_reads_its_version_from_the_directory(self):
        exe = _fake_install(os.path.join(self.tmp.name, "pf"),
                            "Google\\Chrome\\Application\\chrome.exe")
        eng = pdf_out.find_browser()
        self.assertEqual(eng.exe, exe)
        self.assertEqual(eng.kind, "chrome")
        self.assertEqual(eng.version, "151.0.7922.76")

    def test_version_never_shells_out(self):
        # `chrome.exe --version` on Windows relays to the running instance and
        # prints "Opening in existing browser session" - so running it is both
        # useless and slow.
        _fake_install(os.path.join(self.tmp.name, "pf"),
                      "Google\\Chrome\\Application\\chrome.exe")
        with mock.patch.object(subprocess, "run",
                               side_effect=AssertionError("shelled out")):
            self.assertEqual(pdf_out.find_browser().version, "151.0.7922.76")

    def test_newest_version_directory_wins(self):
        root = os.path.join(self.tmp.name, "pf")
        _fake_install(root, "Google\\Chrome\\Application\\chrome.exe", "151.0.9.9")
        os.makedirs(os.path.join(root, "Google\\Chrome\\Application", "9.0.0.1"))
        self.assertEqual(pdf_out.find_browser().version, "151.0.9.9")

    def test_chrome_is_probed_before_edge(self):
        _fake_install(os.path.join(self.tmp.name, "pf86"),
                      "Microsoft\\Edge\\Application\\msedge.exe")
        self.assertEqual(pdf_out.find_browser().kind, "edge")
        _fake_install(os.path.join(self.tmp.name, "pf"),
                      "Google\\Chrome\\Application\\chrome.exe")
        self.assertEqual(pdf_out.find_browser().kind, "chrome")

    def test_which_is_not_consulted_when_a_path_hits(self):
        _fake_install(os.path.join(self.tmp.name, "pf"),
                      "Google\\Chrome\\Application\\chrome.exe")
        import shutil
        with mock.patch.object(shutil, "which",
                               side_effect=AssertionError("used which")):
            self.assertIsNotNone(pdf_out.find_browser())

    def test_none_when_nothing_is_installed(self):
        import shutil
        with mock.patch.object(shutil, "which", return_value=None):
            self.assertIsNone(pdf_out.find_browser())

    def test_explicit_path_wins_and_must_exist(self):
        exe = _fake_install(os.path.join(self.tmp.name, "x"),
                            "Weird\\Place\\chrome.exe")
        self.assertEqual(pdf_out.find_browser(exe).exe, exe)
        self.assertIsNone(pdf_out.find_browser(os.path.join(self.tmp.name, "nope")))


class WeasyprintTests(unittest.TestCase):
    def test_absent_is_none_not_an_exception(self):
        with mock.patch.object(subprocess, "run", side_effect=FileNotFoundError()):
            self.assertIsNone(pdf_out.find_weasyprint())

    def test_present_returns_a_version(self):
        done = subprocess.CompletedProcess([], 0, stdout="WeasyPrint 62.3\n", stderr="")
        with mock.patch.object(subprocess, "run", return_value=done):
            self.assertEqual(pdf_out.find_weasyprint(), "WeasyPrint 62.3")

    def test_on_path_but_broken_is_absent(self):
        done = subprocess.CompletedProcess([], 1, stdout="", stderr="boom")
        with mock.patch.object(subprocess, "run", return_value=done):
            self.assertIsNone(pdf_out.find_weasyprint())


class ChooseEngineTests(unittest.TestCase):
    def setUp(self):
        self.browser = pdf_out.Engine("chrome", "chrome.exe", "151.0.0.0")

    def test_faces_prefer_the_browser(self):
        # weasyprint would print every face blank, which is worse than the
        # placeholder it replaced.
        with mock.patch.object(pdf_out, "find_browser", return_value=self.browser), \
             mock.patch.object(pdf_out, "find_weasyprint", return_value="WeasyPrint 62"):
            eng, why = pdf_out.choose_engine("auto", has_faces=True)
        self.assertEqual(eng.kind, "chrome")
        self.assertIn("faces", why)

    def test_no_faces_prefer_weasyprint(self):
        with mock.patch.object(pdf_out, "find_browser", return_value=self.browser), \
             mock.patch.object(pdf_out, "find_weasyprint", return_value="WeasyPrint 62"):
            eng, why = pdf_out.choose_engine("auto", has_faces=False)
        self.assertEqual(eng.kind, "weasyprint")
        self.assertIn("page numbers", why)

    def test_falls_back_to_whatever_exists(self):
        with mock.patch.object(pdf_out, "find_browser", return_value=None), \
             mock.patch.object(pdf_out, "find_weasyprint", return_value="WeasyPrint 62"):
            eng, why = pdf_out.choose_engine("auto", has_faces=True)
        self.assertEqual(eng.kind, "weasyprint")
        self.assertIn("placeholders", why)

    def test_nothing_available(self):
        with mock.patch.object(pdf_out, "find_browser", return_value=None), \
             mock.patch.object(pdf_out, "find_weasyprint", return_value=None):
            eng, _why = pdf_out.choose_engine("auto")
        self.assertIsNone(eng)

    def test_an_explicit_request_is_not_second_guessed(self):
        with mock.patch.object(pdf_out, "find_browser", return_value=self.browser), \
             mock.patch.object(pdf_out, "find_weasyprint", return_value=None):
            eng, _ = pdf_out.choose_engine("chrome", has_faces=False)
            self.assertEqual(eng.kind, "chrome")
            self.assertIsNone(pdf_out.choose_engine("weasyprint")[0])


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.html = os.path.join(self.tmp.name, "doc.html")
        with open(self.html, "w") as f:
            f.write("<p>hi</p>")
        self.pdf = os.path.join(self.tmp.name, "doc.pdf")
        self.engine = pdf_out.Engine("chrome", "chrome.exe", "151.0.0.0")

    def _run_writing(self, payload):
        def fake(argv, **kw):
            target = [a for a in argv if str(a).startswith("--print-to-pdf=")]
            if target:
                with open(str(target[0]).split("=", 1)[1], "wb") as f:
                    f.write(payload)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        return fake

    def test_argv_is_exactly_what_we_intend(self):
        seen = {}

        def fake(argv, **kw):
            seen["argv"] = argv
            with open(argv[-2].split("=", 1)[1], "wb") as f:
                f.write(b"%PDF-1.4" + b"x" * 2000)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with mock.patch.object(subprocess, "run", side_effect=fake):
            ok, _ = pdf_out.render_pdf(self.html, self.pdf, self.engine, timeout=30)
        self.assertTrue(ok)
        argv = seen["argv"]
        self.assertEqual(argv[0], "chrome.exe")
        self.assertIn("--headless", argv)
        # A fresh profile is NOT optional: without it Windows hands the command
        # to the already-running browser, which returns having printed nothing.
        self.assertTrue(any(a.startswith("--user-data-dir=") for a in argv))
        # Load-bearing, measured: without it the same document produced 2 images
        # instead of 86 - the face canvases had not painted before the snapshot.
        self.assertIn("--virtual-time-budget=30000", argv)
        self.assertTrue(argv[-1].startswith("file:///"))

    def test_a_non_pdf_is_a_failure_even_on_exit_zero(self):
        with mock.patch.object(subprocess, "run",
                               side_effect=self._run_writing(b"<html>nope</html>")):
            ok, msg = pdf_out.render_pdf(self.html, self.pdf, self.engine)
        self.assertFalse(ok)
        self.assertIn("no usable PDF", msg)

    def test_a_tiny_pdf_is_a_failure(self):
        with mock.patch.object(subprocess, "run",
                               side_effect=self._run_writing(b"%PDF-1.4")):
            ok, _ = pdf_out.render_pdf(self.html, self.pdf, self.engine)
        self.assertFalse(ok)

    def test_a_missing_input_is_caught_before_the_engine_runs(self):
        # Otherwise the browser prints its own "file not found" page, quite
        # successfully, and the result passes every check downstream.
        with mock.patch.object(subprocess, "run",
                               side_effect=AssertionError("ran the engine")):
            ok, msg = pdf_out.render_pdf(os.path.join(self.tmp.name, "gone.html"),
                                         self.pdf, self.engine)
        self.assertFalse(ok)
        self.assertIn("no such file", msg)

    def test_timeout_reports_the_remedy_and_cleans_up(self):
        before = set(os.listdir(tempfile.gettempdir()))
        with mock.patch.object(subprocess, "run",
                               side_effect=subprocess.TimeoutExpired("chrome", 1)):
            ok, msg = pdf_out.render_pdf(self.html, self.pdf, self.engine, timeout=1)
        self.assertFalse(ok)
        self.assertIn("--pdf-timeout", msg)
        leaked = [d for d in set(os.listdir(tempfile.gettempdir())) - before
                  if d.startswith("sbs-pdf-")]
        self.assertEqual(leaked, [])

    def test_a_stale_pdf_cannot_look_like_success(self):
        with open(self.pdf, "wb") as f:
            f.write(b"%PDF-1.4" + b"old" * 1000)
        with mock.patch.object(subprocess, "run",
                               return_value=subprocess.CompletedProcess([], 0,
                                                                        stdout="",
                                                                        stderr="")):
            ok, _ = pdf_out.render_pdf(self.html, self.pdf, self.engine)
        self.assertFalse(ok)

    def test_weasyprint_argv(self):
        seen = {}

        def fake(argv, **kw):
            seen["argv"] = argv
            with open(argv[2], "wb") as f:
                f.write(b"%PDF-1.4" + b"x" * 2000)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        eng = pdf_out.Engine("weasyprint", "weasyprint", "62")
        with mock.patch.object(subprocess, "run", side_effect=fake):
            ok, _ = pdf_out.render_pdf(self.html, self.pdf, eng)
        self.assertTrue(ok)
        self.assertEqual(seen["argv"][0], "weasyprint")


if __name__ == "__main__":
    unittest.main()
