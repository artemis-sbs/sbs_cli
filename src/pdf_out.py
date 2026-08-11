"""Turning a rendered HTML document into a PDF, without a Python dependency.

`sbs` runs on the EMBEDDED CPython in `PyRuntime`, whose `python311._pth` has
`import site` commented out - so `site-packages` is never on `sys.path` and
`PYTHONPATH` is ignored. A `pip install` of a PDF library is invisible to this
interpreter no matter how correctly it is run. (`sbs deps` exists for the cases
where a library really is wanted; PDF is not one of them.)

So: **shell out, do not import.** Both engines are external programs, and the
embedded interpreter never has to see a library at all.

Two engines, and they are not interchangeable:

  * **Headless Chrome/Edge** - always available on Windows, and it is the same
    renderer the document was designed against, so what prints is what you saw.
    It composites faces. It does NOT implement `target-counter`, so the contents
    list has no page numbers.
  * **weasyprint** - a real paged formatter. Honors `@page` margins exactly, and
    turns on the `leader(dotted) target-counter(...)` the stylesheet already
    emits, giving real page numbers. But it **runs no JavaScript**, so every face
    would print as a blank canvas - which is why a face-bearing document must be
    re-rendered with `faces="placeholder"` before it is handed over.

That trade is why `choose_engine` prefers the browser when the document has
faces and weasyprint when it does not.
"""
import os
import subprocess
import tempfile

# Chrome first: the stylesheet was authored against it and it is what the
# document has been checked in. Both are Chromium at the same major, so this is
# close to a coin flip - `--browser` and SBS_BROWSER override it either way.
_BROWSER_RELATIVE = (
    ("chrome", "Google\\Chrome\\Application\\chrome.exe"),
    ("edge", "Microsoft\\Edge\\Application\\msedge.exe"),
    ("chromium", "Chromium\\Application\\chrome.exe"),
    ("chrome", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
)
_BROWSER_BASES = ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")

# Last resort only - see find_browser.
_BROWSER_ON_PATH = ("chrome", "google-chrome", "chromium", "chromium-browser",
                    "msedge", "microsoft-edge")


class Engine:
    """A resolved PDF engine. `kind` is `chrome` or `weasyprint`."""

    def __init__(self, kind, exe=None, version="unknown"):
        self.kind = kind
        self.exe = exe
        self.version = version

    def __repr__(self):
        return f"Engine({self.kind}, {self.exe}, {self.version})"

    @property
    def label(self):
        return f"{self.kind} {self.version}".strip()


def _browser_version(exe):
    """The version, read from the `Application\\<version>\\` sibling directory.

    NOT by running the browser: `chrome.exe --version` on Windows relays to the
    already-running instance and prints "Opening in existing browser session"
    instead of a version. Every Chromium install keeps a numbered directory
    beside the exe, so the newest of those is the answer."""
    try:
        app = os.path.dirname(exe)
        versions = [d for d in os.listdir(app)
                    if d[:1].isdigit() and os.path.isdir(os.path.join(app, d))]
    except OSError:
        return "unknown"

    def key(name):
        return [int(p) if p.isdigit() else 0 for p in name.split(".")]

    return sorted(versions, key=key)[-1] if versions else "unknown"


def find_browser(explicit=None):
    """A Chromium-family browser, or None.

    `shutil.which` is tried LAST, and that ordering is the point. On Windows -
    the platform this tool is built for - Chrome and Edge are installed under
    Program Files and are **not on PATH**, so a `which`-first probe reports "no
    browser" on a machine with two of them. `which` is still correct on Linux and
    macOS, so it stays as the fallback rather than being dropped."""
    if explicit:
        return Engine("chrome", explicit, _browser_version(explicit)) \
            if os.path.isfile(explicit) else None
    env = os.environ.get("SBS_BROWSER")
    if env and os.path.isfile(env):
        return Engine("chrome", env, _browser_version(env))
    for kind, rel in _BROWSER_RELATIVE:
        for base in _BROWSER_BASES:
            root = os.environ.get(base)
            if not root:
                continue
            exe = os.path.join(root, rel)
            if os.path.isfile(exe):
                return Engine(kind, exe, _browser_version(exe))
    import shutil
    for name in _BROWSER_ON_PATH:
        exe = shutil.which(name)
        if exe:
            return Engine("chrome", exe, _browser_version(exe))
    return None


def find_weasyprint():
    """weasyprint's version string, or None when it is not installed.

    Run it and catch `FileNotFoundError` - the house idiom (`fetch_cmd.py`'s git
    probe, `file_help.curlretrieve`), and the right one here because a thing on
    PATH that will not start is not a thing you have."""
    try:
        r = subprocess.run(["weasyprint", "--version"],
                           capture_output=True, text=True, timeout=20)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    return (r.stdout or r.stderr or "").strip().splitlines()[0] if (
        r.stdout or r.stderr) else "weasyprint"


def choose_engine(pref="auto", has_faces=False, browser=None):
    """`(engine, why)` - or `(None, why_not)`.

    `auto` prefers the BROWSER for a document with faces, because weasyprint
    would print every one of them blank, and prefers WEASYPRINT otherwise,
    because it is the better typesetter and turns on the contents page numbers
    the stylesheet already asks for."""
    pref = (pref or "auto").lower()
    if pref == "chrome":
        eng = find_browser(browser)
        return (eng, "requested") if eng else (None, "no browser found")
    if pref == "weasyprint":
        ver = find_weasyprint()
        return ((Engine("weasyprint", "weasyprint", ver), "requested") if ver
                else (None, "weasyprint is not installed"))

    if has_faces:
        eng = find_browser(browser)
        if eng:
            return eng, "the document has faces, which only a browser can composite"
    ver = find_weasyprint()
    if ver:
        why = ("no browser found; weasyprint cannot composite faces so they will "
               "print as placeholders") if has_faces else \
              "weasyprint gives exact page margins and contents page numbers"
        return Engine("weasyprint", "weasyprint", ver), why
    eng = find_browser(browser)
    if eng:
        return eng, "the only engine available"
    return None, "no browser and no weasyprint"


def _valid_pdf(path):
    """Headless Chrome can exit 0 having written nothing, so the exit code is not
    evidence. The artifact is."""
    try:
        if os.path.getsize(path) < 1024:
            return False
        with open(path, "rb") as f:
            return f.read(5) == b"%PDF-"
    except OSError:
        return False


def render_pdf(html_path, pdf_path, engine, timeout=90):
    """`(ok, message)`. Never raises for an engine problem."""
    html_path = os.path.abspath(html_path)
    pdf_path = os.path.abspath(pdf_path)
    if engine is None:
        return False, "no PDF engine"
    if not os.path.isfile(html_path):
        # Worth checking rather than trusting the engine to complain: a browser
        # handed a path it cannot open renders its own "file not found" page and
        # prints THAT, quite successfully. The result is a valid one-page PDF, so
        # every check downstream passes and the failure looks like a success.
        return False, f"no such file: {html_path}"
    try:
        os.makedirs(os.path.dirname(pdf_path), exist_ok=True)
    except OSError:
        pass
    if os.path.exists(pdf_path):
        try:
            os.remove(pdf_path)     # so a stale file cannot look like success
        except OSError:
            pass
    if engine.kind == "weasyprint":
        return _run_weasyprint(html_path, pdf_path, timeout)
    return _run_browser(html_path, pdf_path, engine, timeout)


def _run_browser(html_path, pdf_path, engine, timeout):
    # A FRESH profile is not optional. Without --user-data-dir, Windows Chrome
    # and Edge hand the command to the already-running instance and return
    # immediately, having printed nothing - the same behavior that makes
    # `chrome.exe --version` useless here.
    profile = tempfile.mkdtemp(prefix="sbs-pdf-")
    url = "file:///" + html_path.replace("\\", "/")
    argv = [
        engine.exe,
        "--headless",
        "--disable-gpu",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        f"--virtual-time-budget={int(timeout * 1000)}",
        "--no-pdf-header-footer",
        f"--print-to-pdf={pdf_path}",
        url,
    ]
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return False, f"could not run {engine.exe}"
    except subprocess.TimeoutExpired:
        return False, (f"{engine.kind} did not finish within {timeout}s "
                       "- raise it with --pdf-timeout")
    finally:
        import shutil
        shutil.rmtree(profile, ignore_errors=True)
    if _valid_pdf(pdf_path):
        return True, ""
    detail = (r.stderr or r.stdout or "").strip().splitlines()
    return False, (f"{engine.kind} wrote no usable PDF"
                   + (f": {detail[0]}" if detail else ""))


def _run_weasyprint(html_path, pdf_path, timeout):
    try:
        r = subprocess.run(["weasyprint", html_path, pdf_path],
                           capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return False, "weasyprint is not installed"
    except subprocess.TimeoutExpired:
        return False, (f"weasyprint did not finish within {timeout}s "
                       "- raise it with --pdf-timeout")
    if _valid_pdf(pdf_path):
        return True, ""
    detail = (r.stderr or r.stdout or "").strip().splitlines()
    return False, ("weasyprint wrote no usable PDF"
                   + (f": {detail[0]}" if detail else ""))


NO_ENGINE_HELP = (
    "ERROR: no PDF engine found - need a Chromium browser or the weasyprint CLI\n"
    "       install Microsoft Edge or Google Chrome, or pass "
    "--browser <path to chrome.exe>"
)


# --- PDF outline (the bookmark sidebar) --------------------------------------
# The in-document Contents page comes from the HTML and is always there. This is
# the OTHER table of contents: the tree a reader navigates by in the sidebar,
# which lives in the PDF's `/Outlines` and has no HTML equivalent.
#
# WeasyPrint builds one itself from the `bookmark-level` CSS the stylesheet
# emits. Chrome has no bookmark facility at all - but it does emit a NAMED
# destination per anchor, using our own HTML ids verbatim (`/Dest /bar-amd`),
# with a real `/Dests` dictionary behind them. So the hard part - working out
# which page each record landed on - is already done and sitting in the file;
# all that is missing is the tree.
#
# pypdf is optional, and absent is NORMAL and silent - the contract
# `fs.ryaml_module()` sets out. A document without an outline is a document, and
# nagging about it on every run would be noise.

_HEADING = None


def outline_from_html(html_text):
    """`[(level, title, anchor)]` for the emitted headings, in document order.

    Read out of the RENDERED page rather than the record tree, because each lens
    emits a different subset - the catalog skips fence-less records, the
    screenplay keeps only what is spoken. The page is the only honest account of
    what is actually in the PDF."""
    global _HEADING
    import re
    if _HEADING is None:
        # `<section class="doc" id="x"><h1 ...>Title</h1>` and
        # `<article class="rec" id="y"><h2>Display</h2>` - our own shapes.
        # Two shapes, because not every navigable thing is a heading. The
        # screenplay lens gives each scene a `<p class="scene">` - a script's
        # scenes are exactly what a reader navigates by, and keying only on
        # <hN> left that whole lens with no outline at all.
        _HEADING = re.compile(
            r'id="(?P<id>[^"]+)"[^>]*>\s*'
            r'(?:<h(?P<lvl>[1-6])[^>]*>(?P<title>.*?)</h(?P=lvl)>'
            r'|(?P<scene>))',
            re.S)
    import html as _html
    scene = re.compile(r'<p class="scene" id="(?P<id>[^"]+)"[^>]*>(?P<title>.*?)</p>',
                       re.S)
    out = []
    for m in list(_HEADING.finditer(html_text or "")) + list(
            scene.finditer(html_text or "")):
        if m.group("title") is None:
            continue
        title = re.sub(r"<span class=\"slug\".*?</span>", "", m.group("title"), flags=re.S)
        title = re.sub(r"<[^>]+>", "", title)
        title = _html.unescape(title).strip()
        lvl = m.groupdict().get("lvl") or "2"
        if title and m.group("id") != "toc":
            # The stylesheet says `#toc { bookmark-level: none }` for the
            # weasyprint path; the two outlines must agree.
            out.append((int(lvl), title, m.group("id")))
    return out


def add_outline(pdf_path, entries):
    """Add a bookmark tree to an existing PDF. `(ok, message)`.

    Returns `(False, ...)` and changes nothing when pypdf is absent or the
    destinations do not resolve - never raises, and never leaves a damaged file
    behind, because a PDF without bookmarks is far better than a PDF that will
    not open."""
    if not entries:
        return False, "nothing to outline"
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        return False, "pypdf is not installed"
    try:
        reader = PdfReader(pdf_path)
        named = reader.named_destinations or {}
        page_of = {}
        for i, page in enumerate(reader.pages):
            page_of[id(page.indirect_reference)] = i
        writer = PdfWriter()
        writer.append(reader)

        def page_index(anchor):
            # pypdf keys these with the PDF name-object slash ("/reach--vex"),
            # while the anchor we generated - and that Chrome wrote - has none.
            dest = named.get(anchor) or named.get("/" + anchor)
            if dest is None:
                return None
            try:
                return reader.get_destination_page_number(dest)
            except Exception:
                return None

        parents, added = {}, 0
        for level, title, anchor in entries:
            idx = page_index(anchor)
            if idx is None:
                continue
            parent = None
            for up in range(level - 1, 0, -1):
                if up in parents:
                    parent = parents[up]
                    break
            item = writer.add_outline_item(title, idx, parent=parent)
            parents[level] = item
            for deeper in [k for k in parents if k > level]:
                parents.pop(deeper, None)
            added += 1
        if not added:
            return False, "no destinations resolved"
        tmp = pdf_path + ".outline"
        with open(tmp, "wb") as f:
            writer.write(f)
        os.replace(tmp, pdf_path)
        return True, f"{added} bookmarks"
    except Exception as e:                       # noqa: BLE001 - see docstring
        return False, f"outline skipped ({e})"


def merge_pdfs(parts, target, titles=None):
    """Bind several PDFs into one book, keeping each part's outline under a
    top-level bookmark named for it. `(ok, message)`.

    Needs pypdf; absent, the caller simply keeps the separate files, which is
    what it had before and is not a failure."""
    if len(parts) < 2:
        return False, "nothing to merge"
    try:
        from pypdf import PdfWriter
    except ImportError:
        return False, "pypdf is not installed"
    try:
        writer = PdfWriter()
        for i, part in enumerate(parts):
            label = (titles or [])[i] if titles and i < len(titles) else None
            # `outline_item` makes each lens a chapter, so the four editions
            # stay findable instead of running together into one long file.
            writer.append(part, outline_item=label)
        tmp = target + ".merging"
        with open(tmp, "wb") as f:
            writer.write(f)
        os.replace(tmp, target)
        return True, f"{len(parts)} editions"
    except Exception as e:                       # noqa: BLE001
        return False, f"merge skipped ({e})"
