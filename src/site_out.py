"""The standalone static site - the SAME markdown, rendered.

There is no second emitter. `amd_markdown_page` produces the page, and this module
parses that markdown into HTML and wraps it in a shell. So the two outputs cannot drift:
a bug in a table, a choice or an admonition appears in both, and one test pins both.

`markdown_it` and `mdit_py_plugins` are already inside `sbs.pyz` (they arrive with
textual/rich and nothing else imported them), so this costs no new dependency.

ONE DIALECT DIFFERENCE, and it is the load-bearing construct. Anchors are emitted in
Material's form - a TRAILING `## Display {#id}` - because the mkdocs pages are the
primary artifact and must be idiomatic there. markdown-it's own `attrs` plugin uses a
PRECEDING attribute block instead, so it would leave `{#id}` sitting in the heading
text. The core rule below lifts the trailing form onto the token, which is twelve lines
and keeps the emitter honest. `anchors_plugin` is deliberately not used: it slugs from
the heading TEXT, and these anchors have to come from `path_of`.

Everything is relative and self-contained - no CDN, no web fonts, no fetch. The whole
point is a folder someone can double-click.
"""
import html
import os
import re
import shutil

# `{: #id}` is what the emitter writes now (a bare `{#` is a Jinja comment opener,
# and mkdocs runs pages through the macros plugin first). The colon stays OPTIONAL
# here so this still reads pages generated before that change.
RE_ID = re.compile(r"\s*\{:?\s*#([A-Za-z0-9_.:-]+)\}\s*$")


class RendererUnavailable(Exception):
    """markdown_it is not importable.

    It is BUNDLED in `sbs.pyz` (it arrives with textual, and until now nothing imported
    it), so this never happens for anyone running the shipped tool. It happens running
    from source without the dev requirements, and the message has to say so rather than
    surfacing a bare ModuleNotFoundError from a file the reader has never heard of."""


def make_renderer():
    """A `MarkdownIt` configured to read what `amd_markdown` writes."""
    try:
        from markdown_it import MarkdownIt
        from mdit_py_plugins.admon import admon_plugin
    except ImportError as e:
        raise RendererUnavailable(
            f"{e} - markdown_it ships inside sbs.pyz, so this only happens running "
            "from source. Run `pip install -r requirements.txt` in sbs_cli.") from e

    md = (MarkdownIt("commonmark")
          .enable("table")
          .enable("strikethrough")
          .use(admon_plugin))
    md.core.ruler.push("amd_heading_ids", _heading_ids)
    return md


def _heading_ids(state):
    """Move a trailing `{#id}` off the heading text and onto the tag."""
    for i, token in enumerate(state.tokens):
        if token.type != "heading_open":
            continue
        inline = state.tokens[i + 1]
        m = RE_ID.search(inline.content)
        if m is None:
            continue
        token.attrSet("id", m.group(1))
        inline.content = RE_ID.sub("", inline.content)
        for child in reversed(inline.children or ()):
            if child.type == "text":
                child.content = RE_ID.sub("", child.content)
                break


def render_site(pages, markdown_of, out_dir, title, media_root=None, search=True,
                intro=None):
    """Write the whole site. `markdown_of(page)` returns that page's markdown.

    Returns `(written_paths, search_entries)`."""
    md = make_renderer()
    nav = _nav_tree(pages)
    written = []
    index = []

    for page in pages:
        rel = page["path"][:-3] + ".html" if page["path"].endswith(".md") \
            else page["path"] + ".html"
        text = markdown_of(page)
        body = md.render(text)
        html_out = _shell(title, page, nav, body, "../" * rel.count("/"), rel, search)
        target = os.path.join(out_dir, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="\n") as f:
            f.write(html_out)
        written.append(rel)
        index += _index_entries(page, rel, text)

    _write_assets(out_dir, index, search)

    # A real landing page, not a copy of whichever page sorted first: the root of a
    # site people are handed should say what it is and list what is in it.
    #
    # UNLESS A RECORD PAGE ALREADY CLAIMS IT. A mission with an `index.amd` produces
    # `index.html`, and writing the landing page over it deletes a page every link in
    # the site still points at - silently, because the file is still there.
    if "index.html" not in written:
        root = {"title": title, "path": "index.md"}
        body = md.render(_home_markdown(pages, title, intro))
        with open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8",
                  newline="\n") as f:
            f.write(_shell(title, root, nav, body, "", "index.html", search))
        written.append("index.html")

    # AFTER the pages render, because rendering them is what bakes the faces. Asking
    # `isdir` before the loop is asking before anything has been written, and the
    # answer is always no - which silently ships a site whose every portrait 404s.
    if media_root and os.path.isdir(media_root):
        dest = os.path.join(out_dir, "media")
        if os.path.isdir(dest):
            shutil.rmtree(dest)
        shutil.copytree(media_root, dest)
    return written, index


def _home_markdown(pages, title, intro):
    lines = [f"# {title}", "",
             intro or "Every record this mission ships, generated from its `.amd` "
                      "files.", "",
             "| Page | Records |", "|---|---|"]
    for page in pages:
        rel = page["path"][:-3] + ".html"
        lines.append(f'| [{page.get("title") or rel}]({rel}) | {len(page["nodes"])} |')
    return "\n".join(lines) + "\n"


def _index_entries(page, rel, text):
    """One search row per record - title, page, anchor, and the first prose after it."""
    out = []
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"^#{1,6} (?P<title>.*?)\s*\{:?\s*#(?P<anchor>[^}]+)\}\s*$", line)
        if m is None:
            continue
        snippet = ""
        for follow in lines[i + 1:i + 12]:
            s = follow.strip()
            if not s or s.startswith(("|", "!!!", ">", "-", "#")):
                continue
            snippet = s[:160]
            break
        out.append({"t": m.group("title"), "p": rel,
                    "a": m.group("anchor"), "s": snippet,
                    "g": page.get("title", "")})
    return out


def _nav_tree(pages):
    groups = {}
    for page in pages:
        rel = page["path"][:-3] + ".html"
        folder = os.path.dirname(page["path"])
        groups.setdefault(folder, []).append((page.get("title") or rel, rel))
    return groups


def _nav_html(nav, up, current):
    out = ['<nav class="site-nav"><ul>']
    for folder in sorted(nav):
        if folder:
            out.append(f'<li class="group">{html.escape(_folder_title(folder))}<ul>')
        for title, rel in nav[folder]:
            here = ' class="here"' if rel == current else ""
            out.append(f'<li><a href="{up}{html.escape(rel)}"{here}>'
                       f'{html.escape(title)}</a></li>')
        if folder:
            out.append("</ul></li>")
    out.append("</ul></nav>")
    return "".join(out)


def _folder_title(folder):
    return folder.rsplit("/", 1)[-1].replace("_", " ").replace("-", " ").title()


def _toc_html(body):
    """Built from the ids the renderer ACTUALLY emitted, never from a second pass over
    the source - a contents list that disagrees with the page is worse than none."""
    items = re.findall(r'<h([23]) id="([^"]+)"[^>]*>(.*?)</h[23]>', body, re.S)
    if len(items) < 2:
        return ""
    out = ['<nav class="toc"><div class="toc-title">On this page</div><ul>']
    for level, anchor, text in items:
        label = re.sub(r"<[^>]+>", "", text).strip()
        out.append(f'<li class="l{level}"><a href="#{html.escape(anchor)}">'
                   f'{html.escape(label)}</a></li>')
    out.append("</ul></nav>")
    return "".join(out)


def _shell(site_title, page, nav, body, up, rel, search):
    search_html = (
        f'<input id="q" type="search" placeholder="Search records" autocomplete="off">'
        f'<div id="results"></div>') if search else ""
    scripts = (f'<script src="{up}assets/search-index.js"></script>'
               if search else "")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(page.get("title") or site_title)} - {html.escape(site_title)}</title>
<link rel="stylesheet" href="{up}assets/site.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="{up}index.html">{html.escape(site_title)}</a>
  <div class="search">{search_html}</div>
</header>
<div class="layout">
  {_nav_html(nav, up, rel)}
  <main class="content">{body}</main>
  {_toc_html(body)}
</div>
{scripts}
<script src="{up}assets/site.js"></script>
</body>
</html>
"""


def _write_assets(out_dir, index, search=True):
    assets = os.path.join(out_dir, "assets")
    os.makedirs(assets, exist_ok=True)
    with open(os.path.join(assets, "site.css"), "w", encoding="utf-8",
              newline="\n") as f:
        f.write(SITE_CSS)
    with open(os.path.join(assets, "site.js"), "w", encoding="utf-8",
              newline="\n") as f:
        f.write(SITE_JS)
    if not search:
        # `--no-search` must leave no index behind: an empty one is a search box that
        # answers nothing, which is the failure the flag exists to avoid.
        stale = os.path.join(assets, "search-index.js")
        if os.path.isfile(stale):
            os.remove(stale)
        return
    # A GLOBAL-ASSIGNING SCRIPT, not a JSON file fetched at runtime. `fetch()` is
    # blocked on `file://` by the browser's CORS rules, and the entire point of a
    # standalone site is a folder someone can double-click. A `<script src>` loads
    # fine from `file://`.
    import json
    with open(os.path.join(assets, "search-index.js"), "w", encoding="utf-8",
              newline="\n") as f:
        f.write("window.AMD_SEARCH = " + json.dumps(index, ensure_ascii=False) + ";\n")


SITE_CSS = """\
:root {
  --bg: #ffffff; --fg: #1b1f24; --muted: #5b6570; --line: #e2e6ea;
  --accent: #1d6fb8; --panel: #f6f8fa; --code: #f2f4f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14181d; --fg: #e6eaee; --muted: #9aa5b1; --line: #2a3037;
    --accent: #6fb5f0; --panel: #1b2027; --code: #1f252c;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.6 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.topbar { display: flex; align-items: center; gap: 1rem; padding: .6rem 1rem;
  border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg);
  z-index: 5; }
.brand { font-weight: 600; }
.search { position: relative; margin-left: auto; }
#q { width: 16rem; max-width: 40vw; padding: .35rem .6rem; border: 1px solid var(--line);
  border-radius: 6px; background: var(--panel); color: var(--fg); }
#results { position: absolute; right: 0; top: 2.2rem; width: 28rem; max-width: 80vw;
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  max-height: 70vh; overflow: auto; display: none; }
#results.on { display: block; }
#results a { display: block; padding: .5rem .7rem; border-bottom: 1px solid var(--line); }
#results a:last-child { border-bottom: 0; }
#results .s { color: var(--muted); font-size: .85em; display: block; }
#results a.sel { background: var(--panel); }
.layout { display: grid; grid-template-columns: 16rem minmax(0, 1fr) 14rem;
  gap: 1.5rem; max-width: 88rem; margin: 0 auto; padding: 1.2rem 1rem; }
.site-nav { font-size: .92em; }
.site-nav ul { list-style: none; margin: 0; padding: 0; }
.site-nav li { margin: .15rem 0; }
.site-nav .group { color: var(--muted); font-size: .85em; text-transform: uppercase;
  letter-spacing: .04em; margin-top: .9rem; }
.site-nav .group ul { text-transform: none; letter-spacing: 0; font-size: 1.08em;
  color: var(--fg); padding-left: .6rem; }
.site-nav a.here { font-weight: 600; color: var(--fg); }
.content { min-width: 0; }
.content h1 { font-size: 1.9rem; margin-top: 0; }
.content h2 { margin-top: 2rem; padding-bottom: .25rem; border-bottom: 1px solid var(--line); }
.content h3, .content h4 { margin-top: 1.6rem; }
.content table { border-collapse: collapse; margin: 1rem 0; font-size: .93em; }
.content th, .content td { border: 1px solid var(--line); padding: .35rem .6rem;
  text-align: left; vertical-align: top; }
.content th { background: var(--panel); }
.content blockquote { margin: 1rem 0; padding: .1rem 1rem; border-left: 3px solid var(--line);
  color: var(--fg); background: var(--panel); border-radius: 0 6px 6px 0; }
.content code { background: var(--code); padding: .1em .35em; border-radius: 4px;
  font-size: .9em; }
.content pre { background: var(--code); padding: .8rem; border-radius: 8px; overflow-x: auto; }
.content pre code { background: none; padding: 0; }
.content img { max-width: 100%; height: auto; vertical-align: middle;
  background: var(--panel); border-radius: 6px; }
.content hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
/* Wide content scrolls inside itself; the page body never scrolls sideways. */
.table-wrap, .content > table { display: block; overflow-x: auto; max-width: 100%; }
.admonition { border: 1px solid var(--line); border-left: 4px solid var(--accent);
  border-radius: 6px; padding: .1rem 1rem; margin: 1rem 0; background: var(--panel); }
.admonition-title { font-weight: 600; margin: .7rem 0 .2rem; }
.admonition.warning { border-left-color: #d08b26; }
.admonition.danger, .admonition.failure { border-left-color: #cc4b37; }
.admonition.abstract { border-left-color: #7a5bd0; }
.admonition.tip { border-left-color: #29a37a; }
.toc { font-size: .88em; position: sticky; top: 4rem; align-self: start;
  max-height: calc(100vh - 6rem); overflow: auto; }
.toc-title { color: var(--muted); text-transform: uppercase; font-size: .85em;
  letter-spacing: .04em; margin-bottom: .4rem; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc li { margin: .2rem 0; }
.toc .l3 { padding-left: .8rem; font-size: .95em; }
@media (max-width: 62rem) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  .site-nav, .toc { position: static; max-height: none; }
  .toc { display: none; }
}
"""

SITE_JS = """\
(function () {
  var q = document.getElementById('q'), box = document.getElementById('results');
  if (!q || !box || !window.AMD_SEARCH) return;
  var here = document.currentScript ? document.currentScript.src : '';
  var up = (location.pathname.split('/').length - 1);
  function prefix() {
    var d = (document.querySelector('link[rel=stylesheet]') || {}).getAttribute
      ? document.querySelector('link[rel=stylesheet]').getAttribute('href') : '';
    return d.replace('assets/site.css', '');
  }
  var base = prefix(), sel = -1, shown = [];
  function render(items) {
    shown = items; sel = -1;
    box.innerHTML = items.map(function (r) {
      return '<a href="' + base + r.p + '#' + r.a + '"><strong>' + esc(r.t) +
             '</strong><span class="s">' + esc(r.g) +
             (r.s ? ' - ' + esc(r.s) : '') + '</span></a>';
    }).join('');
    box.classList.toggle('on', items.length > 0);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function search(term) {
    term = term.trim().toLowerCase();
    if (term.length < 2) { render([]); return; }
    var hits = [], rest = [];
    for (var i = 0; i < window.AMD_SEARCH.length; i++) {
      var r = window.AMD_SEARCH[i];
      if ((r.t || '').toLowerCase().indexOf(term) >= 0) hits.push(r);
      else if ((r.s || '').toLowerCase().indexOf(term) >= 0) rest.push(r);
      if (hits.length >= 30) break;
    }
    render(hits.concat(rest).slice(0, 30));
  }
  q.addEventListener('input', function () { search(q.value); });
  q.addEventListener('keydown', function (e) {
    var links = box.querySelectorAll('a');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!links.length) return;
      e.preventDefault();
      if (sel >= 0) links[sel].classList.remove('sel');
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
      links[sel].classList.add('sel');
      links[sel].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && sel >= 0 && links[sel]) {
      location.href = links[sel].getAttribute('href');
    } else if (e.key === 'Escape') {
      q.value = ''; render([]);
    }
  });
  document.addEventListener('click', function (e) {
    if (!box.contains(e.target) && e.target !== q) box.classList.remove('on');
  });
})();
"""
