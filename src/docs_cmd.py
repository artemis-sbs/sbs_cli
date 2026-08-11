"""`sbs docs` - render a mission's AMD into a printable document.

AMD is where a mission's design lives, and until now the only thing that could
read it was the game. This turns a mission folder into one self-contained HTML
file laid out for paper; "Print to PDF" in the browser is the PDF step.

Discovery deliberately mirrors `lint_cmd`, including the two steps that look
skippable and are not:

  * `_load_mission_vocabulary` - without it the shipped corpus reports 174 false
    unknown-field warnings instead of 2, which for the catalog lens means 174
    fields rendered as untyped text boxes instead of typed widgets.
  * `amd_core.parse(None, file_path=...)` rather than `open().read()`, so the one
    encoding reader is used. A bare `open()` decodes by locale codepage, and one
    file read two ways is two different documents.
"""
import glob
import os
import sys
import webbrowser

import click

from cli_cmd import cli, zipapp_dir
from lint_cmd import (_load_mission_vocabulary, _prefer_working_tree_sbs_utils,
                      sbs_lib_import)

LENSES = ("prose", "catalog", "screenplay", "bible")


def _load_render(missions, mission):
    """Import the renderer - working tree first, else the mission's own sbslib."""
    _prefer_working_tree_sbs_utils(missions, mission)
    sys.path.insert(0, mission)
    try:
        from sbs_utils.procedural import amd_core, amd_render
    except Exception:
        sbs_lib_import(missions, mission)
        from sbs_utils.procedural import amd_core, amd_render
    # AFTER sbs_utils resolves and BEFORE any file is read, so the mission's own
    # registered field names are declared by the time the schema is consulted.
    _load_mission_vocabulary(mission)
    return amd_core, amd_render


def _pick(paths, include, exclude):
    def matches(path, pats):
        name = path.replace("\\", "/")
        return any(glob.fnmatch.fnmatch(name, p) or glob.fnmatch.fnmatch(
            os.path.basename(name), p) for p in pats)

    if include:
        paths = [p for p in paths if matches(p, include)]
    if exclude:
        paths = [p for p in paths if not matches(p, exclude)]
    return paths


def _order(mission, paths, amd_core):
    """Path order, unless the mission has a table-of-contents root that names its
    files - `OpenUniverse/default.amd` and `peacetime_remastered.amd` are both
    that shape, and their author's order is the reading order.

    `amd_doc._amd_file_list` is parser-agnostic (it reads a fence dict), so it
    works on an `amd_core` node without dragging in the runtime reader, which
    needs the engine and builds a tree with no spans."""
    try:
        from sbs_utils.procedural.amd_doc import _amd_file_list
    except Exception:
        return paths
    named = []
    for path in paths:
        try:
            doc = amd_core.parse(None, file_path=path)
        except Exception:
            continue
        base = os.path.dirname(path)
        for node in doc.nodes:
            for fname in _amd_file_list(node.data or {}) or ():
                cand = os.path.normpath(os.path.join(base, str(fname)))
                if cand in paths and cand not in named:
                    named.append(cand)
    return named + [p for p in paths if p not in named] if named else paths


@cli.command(short_help="Render a mission's AMD as a printable document")
@click.argument("folder", default=".")
@click.option("--lens", "lenses", multiple=True,
              type=click.Choice(LENSES + ("all",)), default=("prose",),
              help="Which reading of the AMD to render. Repeatable.")
@click.option("--profile", type=click.Choice(["author", "player"]), default="author",
              help="author keeps notes, triggers and outcomes; player is a HARD "
                   "filter that leaves them out of the file entirely.")
@click.option("-o", "--out", default=None,
              help="Output path. Default: <folder>/__docs__/<name>-<lens>.html")
@click.option("--format", "fmt", type=click.Choice(["html", "json"]), default="html",
              help="html (printable page) or json (the block model, for tools).")
@click.option("--assets", type=click.Choice(["embed", "link", "none"]), default="none",
              help="How to handle image:// art. face:// and ship:// are always "
                   "placeholders - the engine composites both at runtime.")
@click.option("--title", default=None, help="Document title. Default: the folder name.")
@click.option("--include", multiple=True, help="Only these .amd files (glob). Repeatable.")
@click.option("--exclude", multiple=True, help="Skip these .amd files (glob). Repeatable.")
@click.option("--show-internal", is_flag=True,
              help="Show fields the schema marks internal (for schema debugging).")
@click.option("--open", "do_open", is_flag=True, help="Open the result in a browser.")
@click.option("--pdf", is_flag=True,
              help="Also write a PDF, using a headless browser or the "
                   "weasyprint CLI. No Python library is involved.")
@click.option("--pdf-engine", type=click.Choice(["auto", "chrome", "weasyprint"]),
              default="auto", show_default=True,
              help="auto prefers a browser when the document has faces "
                   "(only a browser can composite them) and weasyprint "
                   "otherwise (exact margins, contents page numbers).")
@click.option("--browser", default=None,
              help="Path to chrome.exe / msedge.exe. Default: found by probing.")
@click.option("--pdf-timeout", default=90, show_default=True,
              help="Seconds to allow the PDF engine.")
@click.pass_context
def docs(ctx, folder, lenses, profile, out, fmt, assets, title, include, exclude,
         show_internal, do_open, pdf, pdf_engine, browser, pdf_timeout):
    """Render the .amd files under a mission FOLDER as a printable document.

    Four lenses, because AMD is three documents wearing one syntax:

    \b
      prose       a manual or story book  - help, lore, codex
      catalog     a sourcebook            - sides, items, scans, landmarks
      screenplay  a script                - dialogue and beats, Fountain-style
      bible       a design document       - the quest spine, triggers and graph

    PDF: open the HTML and print to PDF. Page numbers in the table of contents
    only appear under a real paged formatter (WeasyPrint, Prince); browsers do
    not implement them, and supply their own page numbers in the print header.
    """
    missions = zipapp_dir
    mission = os.path.join(missions, folder)
    if not os.path.isdir(mission):
        mission = folder                      # an absolute or cwd-relative path
    if not os.path.isdir(mission):
        print(f"ERROR: not a folder: {folder}")
        raise SystemExit(2)

    try:
        amd_core, amd_render = _load_render(missions, mission)
    except Exception as e:
        print(f"ERROR: could not load sbs_utils to render ({e})")
        raise SystemExit(2)

    wanted = LENSES if "all" in lenses else tuple(dict.fromkeys(lenses))
    paths = sorted(glob.glob(os.path.join(mission, "**", "*.amd"), recursive=True))
    paths = _order(mission, _pick(paths, include, exclude), amd_core)
    if not paths:
        print(f"No .amd files under {mission}")
        return

    docs_ = []
    for path in paths:
        try:
            docs_.append((path, amd_core.parse(None, file_path=path)))
        except Exception as e:
            print(f"WARNING: skipping {path} ({e})")
    if not docs_:
        raise SystemExit(2)

    if pdf and fmt == "json":
        print("ERROR: --pdf has nothing to render from --format json")
        raise SystemExit(2)

    if pdf and assets == "none" and _was_default(ctx, "assets"):
        # A PDF is where the art actually matters, and `link` costs nothing:
        # MissionAssets emits paths relative to out_dir, which IS __docs__ - the
        # folder the HTML lands in - so the references resolve for the engine and
        # the HTML stays small. Only the DEFAULT is upgraded; someone who typed
        # `--assets none` meant it.
        assets = "link"
        print("--pdf: using --assets link (art referenced from __docs__); "
              "pass --assets none for a text-only PDF")

    name = title or os.path.basename(os.path.abspath(mission))
    resolver = _assets(mission, assets, amd_render)
    built = []
    for lens in wanted:
        if lens == "bible" and profile == "player":
            print("SKIP bible: it has no player profile (the bible IS the spoiler)")
            continue
        try:
            if fmt == "json":
                text = _json(docs_, lens, profile)
                ext = "json"
            else:
                text = amd_render.amd_render_html(
                    docs_, lens=lens, profile=profile, title=name,
                    assets=resolver, show_internal=show_internal)
                ext = "html"
        except Exception as e:
            print(f"ERROR: {lens}: {e}")
            raise SystemExit(1)
        target = out if out and len(wanted) == 1 else os.path.join(
            mission, "__docs__", f"{name}-{lens}.{ext}")
        os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        size = len(text.encode("utf-8")) / 1048576.0
        note = f"  ({size:.1f} MB)" if size >= 1 else ""
        print(f"{lens:11} {len(docs_):3} files -> {target}{note}")
        if size >= 8:
            # Embedded face atlases dominate: one race sheet is up to
            # 3.8 MB, and a cast that spans every race pulls all six in.
            print("  large page - try --assets link to reference the art "
                  "instead of inlining it")
        if pdf and fmt != "json":
            made = _write_pdf(target, name, lens, amd_render, docs_, profile,
                              resolver, show_internal, pdf_engine, browser,
                              pdf_timeout, out, len(wanted))
            if made:
                built.append((made, lens))
        if do_open:
            webbrowser.open(f"file://{os.path.abspath(target)}")

    if len(built) > 1:
        _merge_book(built, mission, name)
    _report_assets(resolver)


def _merge_book(built, mission, name):
    """Bind the editions into one book when more than one was produced."""
    import pdf_out

    target = os.path.join(mission, "__docs__", f"{name}-book.pdf")
    ok, msg = pdf_out.merge_pdfs([p for p, _l in built], target,
                                 titles=[l.title() for _p, l in built])
    if ok:
        size = os.path.getsize(target) / 1048576.0
        print(f"{'':11} book -> {target}  ({size:.1f} MB, {msg})")
    elif "not installed" in msg:
        print(f"{'':11} (sbs deps install pypdf to bind the editions into one book)")


def _was_default(ctx, param):
    """True when the user did not type this option.

    click knows the difference between "not given" and "given the same value the
    default happens to be", and here that difference decides whether we may
    change it under them."""
    try:
        return ctx.get_parameter_source(param).name == "DEFAULT"
    except Exception:
        return True


def _write_pdf(html_path, name, lens, amd_render, docs_, profile, resolver,
               show_internal, pref, browser, timeout, out, lens_count):
    """Render `html_path` to a PDF beside it."""
    import pdf_out

    has_faces = False
    try:
        with open(html_path, encoding="utf-8") as f:
            has_faces = "data-face=" in f.read()
    except OSError:
        pass

    engine, why = pdf_out.choose_engine(pref, has_faces=has_faces, browser=browser)
    if engine is None:
        print(pdf_out.NO_ENGINE_HELP)
        raise SystemExit(2)

    source = html_path
    temp = None
    if engine.kind == "weasyprint" and has_faces:
        # weasyprint runs no JavaScript, so every canvas would print BLANK - the
        # same silent failure the canvas guard exists to prevent, arrived at from
        # the other side. Give it a copy whose faces are honest placeholders and
        # leave the canvas version as the file the reader opens in a browser.
        temp = os.path.splitext(html_path)[0] + ".print.html"
        with open(temp, "w", encoding="utf-8", newline="") as f:
            f.write(amd_render.amd_render_html(
                docs_, lens=lens, profile=profile, title=name, assets=resolver,
                show_internal=show_internal, faces="placeholder"))
        source = temp
        print("  weasyprint runs no JavaScript - faces print as placeholders")
        print("     pass --pdf-engine chrome to composite them, at the cost of "
              "contents page numbers")

    if out and lens_count == 1 and out.lower().endswith(".pdf"):
        target = out
    else:
        target = os.path.splitext(html_path)[0] + ".pdf"

    try:
        ok, msg = pdf_out.render_pdf(source, target, engine, timeout=timeout)
    finally:
        if temp:
            try:
                os.remove(temp)
            except OSError:
                pass
    if not ok:
        print(f"ERROR: {msg}")
        raise SystemExit(1)
    size = os.path.getsize(target) / 1048576.0
    note = ""
    if engine.kind != "weasyprint":
        # weasyprint builds its own outline from the `bookmark-level` CSS.
        # Chrome has no bookmark facility, but it does emit a named destination
        # per anchor - so the pages are already known and only the tree is
        # missing. Absent pypdf, the PDF is simply outline-less, which is a
        # document, not a failure.
        with open(html_path, encoding="utf-8") as f:
            entries = pdf_out.outline_from_html(f.read())
        ok_o, msg_o = pdf_out.add_outline(target, entries)
        note = f", {msg_o}" if ok_o else ""
        if not ok_o and "not installed" in msg_o:
            note = ", no bookmarks (sbs deps install pypdf)"
    print(f"{'':11} pdf ({engine.label}) -> {target}  ({size:.1f} MB{note})")
    print(f"{'':11}   {why}")
    return target


def _report_assets(resolver):
    """Say what art did not resolve.

    A placeholder on the page is honest, but silent placeholders are how a
    document ships with every illustration missing and nobody notices. Note
    that engine built-in atlas keys (`ball`, `test`) legitimately do not
    resolve from a mission folder - they live in the Artemis install.
    """
    missing = sorted(set(getattr(resolver, "missing", ()) or ()))
    big = getattr(resolver, "skipped", ()) or ()
    if missing:
        print(f"  {len(missing)} image(s) not found: "
              + ", ".join(str(m) for m in missing[:6])
              + (" ..." if len(missing) > 6 else ""))
    for name, size in big:
        print(f"  {name} is {size // 1024}KB - too large to inline, placeheld")


def _assets(mission, mode, amd_render):
    if mode == "none":
        return amd_render.NoAssets()
    from sbs_utils.procedural.amd_assets import MissionAssets
    return MissionAssets(mission, embed=(mode == "embed"),
                         out_dir=os.path.join(mission, "__docs__"))


def _json(docs_, lens, profile):
    """The block model, as data. This is the golden-test artifact, what a future
    PDF writer or the VS Code extension consumes without re-parsing, and the
    mirror of `sbs lint --format json`."""
    import json

    from sbs_utils.procedural.amd_blocks import amd_blocks
    from sbs_utils.procedural.amd_core import path_of

    payload = []
    for uri, doc in docs_:
        records = []
        for node in doc.nodes:
            records.append({
                "path": path_of(node), "key": node.key, "display": node.display,
                "level": node.level, "archetype": node.kind,
                "data": node.data or {},
                "blocks": amd_blocks(node, doc=doc, profile=profile),
            })
        payload.append({"file": uri, "records": records})
    return json.dumps({"lens": lens, "profile": profile, "files": payload},
                      indent=2, default=str)
