"""`sbs site` - AMD as a documentation WEBSITE.

Deliberately a separate command from `sbs docs`, which renders one printable document
through four editorial lenses. Two nouns, two commands: `docs` makes a thing you print,
`site` makes a thing you browse. Folding this in as a flag would have made every
`docs` option mean two things.

    sbs site FOLDER --emit includes   refill <!-- amd:begin ... --> blocks in a docs tree
    sbs site FOLDER --emit records    write a page per .amd, and the nav to reach it

`--emit includes` is the drift killer. Documentation pages that explain AMD have to
show some, and every one of those examples was hand-copied. One copy taught `When:` as
the completion trigger when it is an alias of `Starts when:`, the START one - a quest
written from that page never completes. See `procedural/amd_include.py`.

`--emit records` publishes what nothing published before: roughly 380 records across
the two shipped missions - race lore, console help, sides, bar patrons - had no web
presence at all. Pages are written INTO the mission's own repo and committed there,
because the parent site stitches those repos in with the multirepo plugin, which
clones them from GitHub at build time; anything generated only in the parent would
never appear.

`--check` renders without writing and exits non-zero if anything WOULD change. That is
what makes "edited an .amd and forgot to regenerate" a red build instead of the silent
rot this command exists to end.

Discovery mirrors `docs_cmd` exactly, including `_load_mission_vocabulary` - without
it a mission's own registered field names are undeclared when the schema is consulted,
and every one of them renders untyped.
"""
import glob as _glob
import json
import os
import sys

import click

from cli_cmd import cli
from lint_cmd import (_load_mission_vocabulary, _prefer_working_tree_sbs_utils,
                      sbs_lib_import)

_LOADED_MISSION = None

NAV_BEGIN = "  # BEGIN generated records nav"
NAV_END = "  # END generated records nav"


def _load(missions, mission):
    """Import the library - working tree first, else the mission's own sbslib.

    ONE MISSION PER PROCESS, enforced. `amd_register_fields` writes into a
    process-global table and is cumulative, so a second mission's vocabulary is added
    to the first one's rather than replacing it. A `fields` directive rendered after
    that lists fields the mission being documented does not have - Open Universe's
    `Standing:` turning up in the core library's own quest table, which is how this was
    found. The output would depend on the ORDER missions were loaded in, and a
    generator that is order-dependent is worse than the hand-written table it replaces.

    The CLI already satisfies this: one `sbs site` invocation documents one mission.
    The guard is here so that anything calling it twice fails loudly instead of
    quietly emitting a wrong table."""
    global _LOADED_MISSION
    if _LOADED_MISSION is not None and _LOADED_MISSION != mission:
        raise click.ClickException(
            "sbs site can document only one mission per process - "
            f"{os.path.basename(_LOADED_MISSION)} is already loaded and AMD vocabulary "
            "registration is cumulative. Run a separate `sbs site` for "
            f"{os.path.basename(mission)}.")
    _prefer_working_tree_sbs_utils(missions, mission)
    sys.path.insert(0, mission)
    try:
        from sbs_utils.procedural import amd_core, amd_include, amd_markdown
    except Exception:
        sbs_lib_import(missions, mission)
        from sbs_utils.procedural import amd_core, amd_include, amd_markdown
    # AFTER sbs_utils resolves and BEFORE any file is read.
    _load_mission_vocabulary(mission)
    _LOADED_MISSION = mission
    return amd_core, amd_include, amd_markdown


def _layout(mission, given):
    """Per-repo choices - page titles, which document splits, what to skip - live in
    the repo as `mkdocs/records.json`, the way `gen_icon_gallery.py` keeps its per-page
    knowledge in the repo it serves. One implementation, many opinions."""
    path = given or os.path.join(mission, "mkdocs", "records.json")
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _documents(mission, amd_core, layout):
    """Every .amd the mission owns, parsed, in path order.

    `__lib__` holds OTHER missions' shipped libraries and `mkdocs` holds the
    documentation itself - publishing either would put someone else's records under
    this mission's name."""
    skip = tuple((layout or {}).get("exclude", ()))
    docs = []
    for path in sorted(_glob.glob(os.path.join(mission, "**", "*.amd"),
                                  recursive=True)):
        rel = os.path.relpath(path, mission).replace(os.sep, "/")
        if rel.startswith("__lib__/") or rel.startswith("mkdocs/"):
            continue
        if any(_glob.fnmatch.fnmatch(rel, pat) for pat in skip):
            continue
        doc = amd_core.parse(None, file_path=path)
        doc.rel_path = rel
        docs.append(doc)
    return docs


def _nav_yaml(pages, root, title):
    """The generated nav block, grouped by the mission's own folder layout.

    Spliced as TEXT between two comment markers rather than round-tripped through a
    YAML library, so every comment and every bit of formatting elsewhere in the file
    survives untouched - the same reason `gen_icon_gallery.py` splices text."""
    groups = {}
    for page in pages:
        folder = os.path.dirname(page["path"]) or ""
        groups.setdefault(folder, []).append(page)
    lines = [NAV_BEGIN, f"  - {title}:", f"    - {root}/index.md"]
    for folder in sorted(groups):
        entries = groups[folder]
        if folder:
            lines.append(f"    - {_folder_title(folder)}:")
            indent = "      "
        else:
            indent = "    "
        for page in entries:
            lines.append(f'{indent}- "{_yaml_str(page["title"])}": '
                         f'{root}/{page["path"]}')
    lines.append(NAV_END)
    return "\n".join(lines)


def _folder_title(folder):
    return folder.rsplit("/", 1)[-1].replace("_", " ").replace("-", " ").title()


def _yaml_str(text):
    return str(text).replace("\\", "\\\\").replace('"', '\\"')


def _splice_nav(path, block):
    """Replace the marked span, or add it just before the LAST top-level nav entry
    (conventionally `About`), so a generated section never lands above `Home`."""
    with open(path, encoding="utf-8", newline="") as f:
        raw = f.read()
    crlf = "\r\n" in raw
    body = raw.replace("\r\n", "\n")
    if NAV_BEGIN in body and NAV_END in body:
        head, _, rest = body.partition(NAV_BEGIN)
        _, _, tail = rest.partition(NAV_END)
        body = head + block + tail
    else:
        lines = body.split("\n")
        try:
            nav_at = next(i for i, l in enumerate(lines) if l.rstrip() == "nav:")
        except StopIteration:
            raise click.ClickException(f"{path} has no `nav:` to splice into")
        # BOUND THE SEARCH TO THE nav BLOCK. `markdown_extensions:` and `plugins:` are
        # also lists of `  - ` entries, so scanning the whole file for the last one
        # splices the nav into the plugin list - which mkdocs reports as
        # `The "The mission data" plugin is not installed`, naming nothing useful.
        nav_end = next((i for i in range(nav_at + 1, len(lines))
                        if lines[i].strip() and not lines[i].startswith(" ")),
                       len(lines))
        tops = [i for i in range(nav_at + 1, nav_end) if lines[i].startswith("  - ")]
        if not tops:
            raise click.ClickException(f"{path} has an empty `nav:`")
        # Before the LAST top-level entry (conventionally `About`), so a generated
        # section never lands above `Home`.
        at = tops[-1]
        lines = lines[:at] + block.split("\n") + [""] + lines[at:]
        body = "\n".join(lines)
    new = body.replace("\n", "\r\n") if crlf else body
    if new == raw:
        return False
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(new)
    return True


def _docs_dirs(mission, given):
    """Where the hand-written pages live. `mkdocs/docs` by convention; `--docs` for
    anything else."""
    if given:
        return [os.path.abspath(given)]
    guess = os.path.join(mission, "mkdocs", "docs")
    return [guess] if os.path.isdir(guess) else []


def _pages(roots):
    for root in roots:
        for dirpath, _, names in os.walk(root):
            for name in sorted(names):
                if name.endswith(".md"):
                    yield os.path.join(dirpath, name)


@cli.command(short_help="Generate documentation from a mission's AMD")
@click.argument("folder", default=".")
@click.option("--emit", type=click.Choice(["includes", "records", "site"]),
              default="includes", show_default=True,
              help="`includes` refills amd:begin blocks in place; `records` writes a "
                   "page per .amd file; `site` builds a standalone HTML site.")
@click.option("--docs", "docs_dir", default=None,
              help="The docs tree to process. Default: <folder>/mkdocs/docs.")
@click.option("--root", default="records", show_default=True,
              help="Subfolder of the docs tree that record pages are written to.")
@click.option("--layout", "layout_path", default=None,
              help="Per-repo choices. Default: <folder>/mkdocs/records.json.")
@click.option("--profile", type=click.Choice(["author", "player"]), default="author",
              show_default=True, help="`player` omits author notes and choice targets.")
@click.option("--nav", "nav_path", default=None,
              help="mkdocs.yml to splice the generated nav into. "
                   "Default: <folder>/mkdocs/mkdocs.yml.")
@click.option("--no-nav", is_flag=True, help="Write pages but leave mkdocs.yml alone.")
@click.option("--faces", type=click.Choice(["bake", "note"]), default="bake",
              show_default=True,
              help="`bake` composites face:// art to PNG; `note` just says it is there.")
@click.option("--check", is_flag=True,
              help="Write nothing; exit 1 if anything would change.")
@click.option("-o", "--out", "out_dir", default=None,
              help="Where `--emit site` writes. Default: <folder>/__site__.")
@click.option("--no-search", is_flag=True, help="Build the site without a search box.")
@click.option("--open", "do_open", is_flag=True,
              help="Open the built site in a browser.")
@click.option("-q", "--quiet", is_flag=True, help="Only report changes and problems.")
def site(folder, emit, docs_dir, root, layout_path, profile, nav_path, no_nav,
         faces, out_dir, no_search, do_open, check, quiet):
    mission = os.path.abspath(folder)
    missions = os.path.dirname(mission)
    if not os.path.isdir(mission):
        raise click.ClickException(f"no such folder: {folder}")

    amd_core, amd_include, amd_markdown = _load(missions, mission)

    if emit == "records":
        return _emit_records(mission, docs_dir, root, layout_path, profile,
                             nav_path, no_nav, faces, check, quiet,
                             amd_core, amd_markdown)
    if emit == "site":
        return _emit_site(mission, out_dir, layout_path, profile, faces,
                          no_search, do_open, quiet, amd_core, amd_markdown)

    roots = _docs_dirs(mission, docs_dir)
    if not roots:
        raise click.ClickException(
            f"no docs tree found - expected {os.path.join(mission, 'mkdocs', 'docs')}"
            " (use --docs to point somewhere else)")

    stale, written, blocks, failed = [], [], 0, []
    for page in _pages(roots):
        # newline="" so the file's own line endings survive the round trip: these
        # pages live in Windows repos, and normalizing them rewrites every line.
        with open(page, encoding="utf-8", newline="") as f:
            before = f.read()
        if amd_include.BEGIN not in before:
            continue
        try:
            after, report = amd_include.amd_include_expand(before, mission)
        except amd_include.IncludeError as e:
            failed.append((page, str(e)))
            continue
        blocks += len(report)
        if after == before:
            continue
        rel = os.path.relpath(page, mission)
        if check:
            stale.append((rel, [d for d, changed in report if changed]))
        else:
            with open(page, "w", encoding="utf-8", newline="") as f:
                f.write(after)
            written.append((rel, [d for d, changed in report if changed]))

    for page, message in failed:
        click.echo(f"ERROR {os.path.relpath(page, mission)}: {message}", err=True)

    for rel, directives in written:
        click.echo(f"updated {rel}")
        if not quiet:
            for d in directives:
                click.echo(f"          {d}")
    for rel, directives in stale:
        click.echo(f"STALE   {rel}")
        for d in directives:
            click.echo(f"          {d}")

    if failed:
        raise click.ClickException(
            f"{len(failed)} page(s) have a directive that could not be rendered")
    if check and stale:
        raise click.ClickException(
            f"{len(stale)} page(s) are out of date - run `sbs site {folder}`")
    if not quiet:
        click.echo(f"{blocks} generated block(s) checked"
                   + ("" if check else f", {len(written)} page(s) updated"))


def _emit_records(mission, docs_dir, root, layout_path, profile, nav_path, no_nav,
                  faces, check, quiet, amd_core, amd_markdown):
    """A page per .amd file, plus an index, plus the nav entries that reach them.

    These pages are COMMITTED into the mission's own repo. The parent documentation
    site stitches LM and OU in with the multirepo plugin, which clones them from
    GitHub at build time - so anything generated only in the parent would never
    appear on the site."""
    layout = _layout(mission, layout_path)
    docs_root = (os.path.abspath(docs_dir) if docs_dir
                 else os.path.join(mission, "mkdocs", "docs"))
    if not os.path.isdir(docs_root):
        raise click.ClickException(f"no docs tree at {docs_root}")

    documents = _documents(mission, amd_core, layout)
    if not documents:
        raise click.ClickException(f"no .amd files found under {mission}")
    pages = amd_markdown.amd_markdown_site(documents, layout=layout)

    out_root = os.path.join(docs_root, root)
    media = _media_renderer(mission, docs_root, root, faces, check)
    written, stale, dangling = [], [], []
    wanted = {}
    for page in pages:
        ctx = amd_markdown.amd_markdown_context(pages, page, profile=profile,
                                                media=media)
        wanted[page["path"]] = amd_markdown.amd_markdown_page(page, ctx)
        dangling += ctx["dangling"]
    wanted["index.md"] = _index_page(pages, layout, mission)

    for rel, text in sorted(wanted.items()):
        target = os.path.join(out_root, rel.replace("/", os.sep))
        current = None
        if os.path.isfile(target):
            with open(target, encoding="utf-8", newline="") as f:
                current = f.read().replace("\r\n", "\n")
        if current == text:
            continue
        (stale if check else written).append(rel)
        if not check:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)

    # A record deleted from the mission must lose its page, or the site keeps serving
    # a record that no longer exists - the drift this whole command exists to end,
    # pointing the other way.
    orphans = _orphans(out_root, wanted)
    for rel in orphans:
        if check:
            stale.append(f"{rel} (no longer generated)")
        else:
            os.remove(os.path.join(out_root, rel.replace("/", os.sep)))
            written.append(f"{rel} (removed)")

    nav_changed = False
    if not no_nav:
        nav_file = nav_path or os.path.join(mission, "mkdocs", "mkdocs.yml")
        if not os.path.isfile(nav_file):
            raise click.ClickException(f"no mkdocs.yml at {nav_file}")
        block = _nav_yaml(pages, root, layout.get("nav_title", "The mission data"))
        if check:
            with open(nav_file, encoding="utf-8", newline="") as f:
                nav_changed = block not in f.read().replace("\r\n", "\n")
            if nav_changed:
                stale.append(os.path.relpath(nav_file, mission))
        else:
            nav_changed = _splice_nav(nav_file, block)
            if nav_changed:
                written.append(os.path.relpath(nav_file, mission))

    if not quiet:
        for rel in written:
            click.echo(f"wrote  {rel}")
    for rel in stale:
        click.echo(f"STALE  {rel}")

    distinct = sorted(set(dangling))
    if distinct and not quiet:
        # Named, never silent. An unresolved target renders as plain text rather than
        # a link, which is right for a MAST label that is not an AMD record and wrong
        # for a genuine typo - and only a person can tell those apart.
        click.echo(f"{len(distinct)} unresolved reference(s) rendered as plain text: "
                   + ", ".join(distinct[:8])
                   + (" ..." if len(distinct) > 8 else ""))
    if check and stale:
        raise click.ClickException(
            f"{len(stale)} generated file(s) are out of date - run `sbs site` again")
    if not quiet:
        click.echo(f"{len(pages)} page(s) from {len(documents)} .amd file(s)"
                   + ("" if check else f", {len(written)} written"))


def _orphans(out_root, wanted):
    if not os.path.isdir(out_root):
        return []
    out = []
    for dirpath, _dirs, names in os.walk(out_root):
        for name in names:
            if not name.endswith(".md"):
                continue
            rel = os.path.relpath(os.path.join(dirpath, name),
                                  out_root).replace(os.sep, "/")
            if rel not in wanted:
                out.append(rel)
    return sorted(out)


def _index_page(pages, layout, mission):
    """The section's landing page - `navigation.indexes` is on in both repos, so the
    group needs one or its heading is not clickable."""
    title = layout.get("nav_title", "The mission data")
    intro = layout.get("index_intro") or (
        "Every record this mission ships, generated from its `.amd` files. These "
        "pages are written by `sbs site` - edit the `.amd`, not the page.")
    rows = ["| Page | Records | Source |", "|---|---|---|"]
    for page in pages:
        src = page.get("uri") or ""
        rows.append(f'| [{page["title"]}]({page["path"]}) | {len(page["nodes"])} '
                    f'| `{src}` |')
    return "\n".join([f"# {title}", "", intro, ""] + rows) + "\n"


def _media_renderer(mission, docs_root, root, faces, check):
    """The `media` callable the markdown emitter injects art through.

    BOTH, OR NEITHER. If a face cannot actually be composited - no PIL, no atlases -
    every face on the page falls back to the honest note, rather than some rendering
    and some leaving a broken image tag that claims art exists and failed to load.
    This is `amd_render._face_capable`'s rule, and it is the reason `capable()` is
    asked once up front instead of per image.

    Copied assets live UNDER the docs tree because mkdocs cannot reference anything
    outside `docs_dir` - the same reason `gen_icon_gallery.py` writes its sheet into
    `docs/media/`."""
    from sbs_utils.procedural.amd_assets import MissionAssets

    assets = MissionAssets(mission, embed=False)
    media_root = os.path.join(docs_root, root, "media")
    baker = None
    if faces == "bake":
        from face_bake import FaceBaker
        # Constructed even when it cannot composite: an already-baked PNG is found by
        # its content-addressed name and referenced without ever opening an atlas,
        # which is what lets a machine with no Cosmos install (CI) reproduce these
        # pages exactly. Only a NEW face needs the atlases, and failing on that is
        # correct - nobody has produced that art yet.
        baker = FaceBaker(assets, os.path.join(media_root, "faces"), "media/faces")
        if not baker.capable() and not check:
            click.echo("faces: cannot composite (PIL or the race atlases are "
                       "unavailable) - already-baked faces still resolve, new ones "
                       "will be named instead", err=True)

    def render(block, ctx):
        ns = (block.get("ns") or "").lower()
        url = block.get("url") or ""
        alt = block.get("alt") or ""
        rel = _up_to_root(ctx)
        if ns == "face" and baker is not None:
            baked = baker.bake(url)
            if baked:
                return f"![{alt or 'face'}]({rel}{baked})"
            return None
        if ns == "image":
            found = assets.find(url)
            if found:
                name = os.path.basename(found)
                target = os.path.join(media_root, "art", name)
                if not os.path.isfile(target) and not check:
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with open(found, "rb") as src, open(target, "wb") as dst:
                        dst.write(src.read())
                return f"![{alt or url}]({rel}media/art/{name})"
        # `ship://` is a 3D hull tag, not a picture. The .png beside a mesh is a
        # DIFFUSE TEXTURE and prints as a near-white box, so naming it is the honest
        # answer and the only one that does not lie about what the reader is seeing.
        return None

    return render


def _up_to_root(ctx):
    """`../` per folder deep, so a page in `maps/bosses/` reaches `media/` at the
    records root. Relative, never absolute: the same pages are served from a mkdocs
    site under a subpath and from a folder opened off disk."""
    depth = (ctx.get("page") or {}).get("path", "").count("/")
    return "../" * depth


def _emit_site(mission, out_dir, layout_path, profile, faces, no_search, do_open,
               quiet, amd_core, amd_markdown):
    """A standalone folder of HTML - no server, no CDN, double-click and read.

    It does NOT get its own renderer. `amd_markdown_page` produces exactly the markdown
    the mkdocs pages are written from, and `site_out` parses that. So the two outputs
    cannot drift: any bug here is a bug there."""
    import site_out

    layout = _layout(mission, layout_path)
    out = os.path.abspath(out_dir or os.path.join(mission, "__site__"))
    documents = _documents(mission, amd_core, layout)
    if not documents:
        raise click.ClickException(f"no .amd files found under {mission}")
    pages = amd_markdown.amd_markdown_site(documents, layout=layout)

    media_dir = os.path.join(out, "_media")
    media = _media_renderer_for_site(mission, media_dir, faces)

    def markdown_of(page):
        ctx = amd_markdown.amd_markdown_context(
            pages, page, profile=profile, media=media,
            link=lambda node, c: _html_link(node, c, amd_markdown))
        return amd_markdown.amd_markdown_page(page, ctx)

    try:
        written, index = site_out.render_site(
            pages, markdown_of, out,
            title=layout.get("nav_title") or os.path.basename(mission),
            media_root=media_dir, search=not no_search,
            intro=layout.get("index_intro"))
    except site_out.RendererUnavailable as e:
        raise click.ClickException(str(e))
    if os.path.isdir(media_dir):
        import shutil
        shutil.rmtree(media_dir, ignore_errors=True)

    if not quiet:
        click.echo(f"{len(written)} page(s), {len(index)} record(s) indexed -> {out}")
        if no_search:
            click.echo("search: not built (--no-search)")
    if do_open:
        import webbrowser
        webbrowser.open("file:///" + os.path.join(out, "index.html").replace("\\", "/"))


def _html_link(node, ctx, amd_markdown):
    """The same URL the mkdocs build produces, with `.html` for `.md`. This is one of
    exactly two things the two sites differ by."""
    page = (ctx.get("page_of") or {}).get(id(node))
    if page is None:
        return None
    import posixpath
    anchor = amd_markdown.amd_markdown_anchor(node)
    if page is ctx.get("page"):
        return f"#{anchor}"
    here = posixpath.dirname(ctx["page"]["path"])
    rel = posixpath.relpath(page["path"], here or ".")
    return f"{rel[:-3]}.html#{anchor}" if rel.endswith(".md") else f"{rel}#{anchor}"


def _media_renderer_for_site(mission, media_dir, faces):
    """Same policy as the records emitter, writing into the site's own media folder."""
    from sbs_utils.procedural.amd_assets import MissionAssets

    assets = MissionAssets(mission, embed=False)
    baker = None
    if faces == "bake":
        from face_bake import FaceBaker
        baker = FaceBaker(assets, os.path.join(media_dir, "faces"), "media/faces")

    def render(block, ctx):
        ns = (block.get("ns") or "").lower()
        url, alt = block.get("url") or "", block.get("alt") or ""
        rel = _up_to_root(ctx)
        if ns == "face" and baker is not None:
            baked = baker.bake(url)
            return f"![{alt or 'face'}]({rel}{baked})" if baked else None
        if ns == "image":
            found = assets.find(url)
            if found:
                name = os.path.basename(found)
                target = os.path.join(media_dir, "art", name)
                if not os.path.isfile(target):
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with open(found, "rb") as src, open(target, "wb") as dst:
                        dst.write(src.read())
                return f"![{alt or url}]({rel}media/art/{name})"
        return None

    return render
