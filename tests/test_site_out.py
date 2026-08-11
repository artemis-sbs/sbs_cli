"""The standalone HTML site (site_out).

There is no second emitter: `amd_markdown_page` writes the markdown and this module
parses it. So what needs testing here is not "does AMD render" - `test_amd_markdown`
owns that - but the three things unique to this side:

  * the ONE dialect difference. Anchors are emitted in Material's trailing
    `{#id}` form because the mkdocs pages are the primary artifact; markdown-it's own
    attrs plugin wants a PRECEDING block, so without the core rule every anchor would
    end up as literal text in the heading. That is the most load-bearing construct in
    the design, and it is the one place the two renderers disagree;
  * link integrity - every internal href naming a page that exists and an id that page
    actually emitted, which is what catches a `- [choice](target)` left unrewritten;
  * `file://` survivability. The whole point of "standalone" is a folder someone can
    double-click, and a `fetch()` for a search index is blocked there by CORS.

markdown_it ships inside sbs.pyz and arrives from `textual` in requirements.txt, so CI
has it; a bare source checkout without the dev requirements does not, and these skip.
"""
import os
import re
import tempfile
import unittest

try:
    import markdown_it  # noqa: F401
    HAVE_MDIT = True
except ImportError:
    HAVE_MDIT = False

import site_out

_REAL_MISSIONS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

PAGES = [
    {"path": "index.md", "title": "Home", "nodes": [1, 2]},
    {"path": "maps/bosses/warlord.md", "title": "Warlord", "nodes": [3]},
]

MARKDOWN = {
    "index.md": (
        "# Home {#home}\n\n"
        "Prose with a [link](maps/bosses/warlord.html#warlord-detail).\n\n"
        "## A Section {#home-section}\n\n"
        "| Fact | Value |\n|---|---|\n| Trigger | `enemies_low` |\n\n"
        '!!! warning "Mind the gap"\n\n    The lane narrows.\n\n'
        "## Another Section {#home-other}\n\nMore prose.\n"),
    "maps/bosses/warlord.md": (
        "# Warlord {#warlord}\n\n"
        "Body text.\n\n"
        "## Detail {#warlord-detail}\n\n"
        "Back to [Home](../../index.html#home).\n"),
}


def _build(out, search=True):
    return site_out.render_site(PAGES, lambda p: MARKDOWN[p["path"]], out,
                                title="Demo", search=search)


@unittest.skipUnless(HAVE_MDIT, "markdown_it not installed (pip install -r requirements.txt)")
class TestRendering(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = self.tmp.name
        self.written, self.index = _build(self.out)

    def read(self, rel):
        with open(os.path.join(self.out, rel.replace("/", os.sep)),
                  encoding="utf-8") as f:
            return f.read()

    def test_the_trailing_anchor_becomes_an_id(self):
        # THE dialect difference. markdown-it's attrs plugin uses a PRECEDING block, so
        # without the core rule this ships `<h2>Detail {#warlord-detail}</h2>` - the
        # anchor visible as text and every link to it dead.
        html = self.read("maps/bosses/warlord.html")
        self.assertIn('id="warlord-detail"', html)
        self.assertNotIn("{#", html)

    def test_tables_and_admonitions_render(self):
        html = self.read("index.html")
        self.assertIn("<table>", html)
        # Byte-identical class names to Material's, so one stylesheet covers both sites.
        self.assertIn('class="admonition warning"', html)
        self.assertIn("admonition-title", html)

    def test_a_real_landing_page_not_a_copy_of_the_first(self):
        # The root of a site people are handed should say what it is.
        html = self.read("index.html")
        self.assertIn("Demo", html)

    def test_a_record_page_that_claims_index_html_is_not_overwritten(self):
        # A mission with an `index.amd` produces `index.html`, and writing the landing
        # page over it deletes a page every link in the site still points at -
        # silently, because the file is still sitting there.
        html = self.read("index.html")
        self.assertIn('id="home"', html)
        self.assertIn('id="home-section"', html)

    def test_the_toc_is_built_from_ids_that_were_emitted(self):
        # Never from a second pass over the source: a contents list that disagrees with
        # the page is worse than no contents list.
        html = self.read("index.html")
        toc = re.search(r'<nav class="toc">(.*?)</nav>', html, re.S)
        self.assertIsNotNone(toc)
        for anchor in re.findall(r'href="#([^"]+)"', toc.group(1)):
            self.assertIn(f'id="{anchor}"', html)


@unittest.skipUnless(HAVE_MDIT, "markdown_it not installed")
class TestSelfContained(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = self.tmp.name
        _build(self.out)

    def _all(self, *exts):
        for dirpath, _d, names in os.walk(self.out):
            for n in names:
                if n.endswith(exts):
                    with open(os.path.join(dirpath, n), encoding="utf-8") as f:
                        yield os.path.join(dirpath, n), f.read()

    def test_nothing_reaches_the_network(self):
        # No CDN, no web fonts. A "standalone" site that needs the internet is not one.
        for path, text in self._all(".html", ".css", ".js"):
            for url in re.findall(r'(?:href|src|url)\s*[=(]\s*["\']?(https?://[^"\')\s]+)',
                                  text):
                self.fail(f"{os.path.basename(path)} reaches {url}")

    def test_the_search_index_is_a_script_not_a_fetch(self):
        # `fetch()` is blocked on `file://` by CORS, and the entire point of a
        # standalone site is a folder you can double-click. A <script src> loads fine.
        self.assertTrue(os.path.isfile(
            os.path.join(self.out, "assets", "search-index.js")))
        self.assertFalse(os.path.isfile(
            os.path.join(self.out, "assets", "search.json")))
        for _path, text in self._all(".js"):
            self.assertNotIn("fetch(", text)

    def test_every_asset_reference_is_relative(self):
        for path, text in self._all(".html"):
            for ref in re.findall(r'(?:href|src)="([^"]+)"', text):
                if ref.startswith("#"):
                    continue
                self.assertFalse(ref.startswith("/"),
                                 f"{os.path.basename(path)} has an absolute {ref}")


@unittest.skipUnless(HAVE_MDIT, "markdown_it not installed")
class TestLinkIntegrity(unittest.TestCase):
    """Every internal href names a page that exists and an id that page emitted.

    This is the class of failure a `- [choice](target)` produces when nobody rewrites
    it: valid CommonMark pointing at a KEY rather than a path. There are 44 of them in
    the shipped corpus."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = self.tmp.name
        _build(self.out)

    def test_no_broken_internal_links(self):
        pages, ids = {}, {}
        for dirpath, _d, names in os.walk(self.out):
            for n in names:
                if not n.endswith(".html"):
                    continue
                p = os.path.join(dirpath, n)
                rel = os.path.relpath(p, self.out).replace(os.sep, "/")
                with open(p, encoding="utf-8") as f:
                    pages[rel] = f.read()
                ids[rel] = set(re.findall(r'id="([^"]+)"', pages[rel]))
        broken = []
        for rel, text in pages.items():
            here = os.path.dirname(rel)
            for href in re.findall(r'href="([^"]+)"', text):
                if href.startswith(("http", "mailto:", "#")) or href.endswith(".css"):
                    continue
                target, _, frag = href.partition("#")
                full = os.path.normpath(os.path.join(here, target)).replace(os.sep, "/")
                if full not in pages:
                    broken.append(f"{rel} -> {href} (no such page)")
                elif frag and frag not in ids[full]:
                    broken.append(f"{rel} -> {href} (no such anchor)")
        self.assertEqual(broken, [], "\n".join(broken))


@unittest.skipUnless(HAVE_MDIT, "markdown_it not installed")
class TestSearch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = self.tmp.name

    def test_one_entry_per_record_with_a_page_and_an_anchor(self):
        _written, index = _build(self.out)
        self.assertTrue(index)
        for row in index:
            self.assertTrue(row["p"].endswith(".html"))
            self.assertTrue(row["a"])
            self.assertTrue(row["t"])

    def test_no_search_ships_no_index_and_no_box(self):
        # Better than a search box that silently returns nothing.
        _build(self.out, search=False)
        self.assertFalse(os.path.isfile(
            os.path.join(self.out, "assets", "search-index.js")))
        with open(os.path.join(self.out, "index.html"), encoding="utf-8") as f:
            self.assertNotIn('id="q"', f.read())


class TestTheErrorWhenItCannotRun(unittest.TestCase):
    def test_a_missing_markdown_it_says_what_to_do(self):
        # A bare ModuleNotFoundError names a file the reader has never heard of.
        import builtins
        from unittest import mock
        real = builtins.__import__

        def fake(name, *a, **kw):
            if name.startswith(("markdown_it", "mdit_py_plugins")):
                raise ImportError(f"No module named '{name}'")
            return real(name, *a, **kw)

        with mock.patch.object(builtins, "__import__", fake):
            with self.assertRaises(site_out.RendererUnavailable) as ctx:
                site_out.make_renderer()
        self.assertIn("requirements.txt", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
