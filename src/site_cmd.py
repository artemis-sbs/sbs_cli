"""`sbs site` - AMD as a documentation WEBSITE.

Deliberately a separate command from `sbs docs`, which renders one printable document
through four editorial lenses. Two nouns, two commands: `docs` makes a thing you print,
`site` makes a thing you browse. Folding this in as a flag would have made every
`docs` option mean two things.

    sbs site FOLDER --emit includes    refill <!-- amd:begin ... --> blocks in a docs tree

`--emit includes` is the drift killer. Documentation pages that explain AMD have to
show some, and every one of those examples was hand-copied. One copy taught `When:` as
the completion trigger when it is an alias of `Starts when:`, the START one - a quest
written from that page never completes. See `procedural/amd_include.py`.

`--check` renders without writing and exits non-zero if anything WOULD change. That is
what makes "edited an .amd and forgot to regenerate" a red build instead of the silent
rot this command exists to end.

Discovery mirrors `docs_cmd` exactly, including `_load_mission_vocabulary` - without
it a mission's own registered field names are undeclared when the schema is consulted,
and every one of them renders untyped.
"""
import os
import sys

import click

from cli_cmd import cli
from lint_cmd import (_load_mission_vocabulary, _prefer_working_tree_sbs_utils,
                      sbs_lib_import)

_LOADED_MISSION = None


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
        from sbs_utils.procedural import amd_include
    except Exception:
        sbs_lib_import(missions, mission)
        from sbs_utils.procedural import amd_include
    # AFTER sbs_utils resolves and BEFORE any file is read.
    _load_mission_vocabulary(mission)
    _LOADED_MISSION = mission
    return amd_include


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
@click.option("--emit", type=click.Choice(["includes"]), default="includes",
              show_default=True,
              help="What to generate. `includes` refills amd:begin blocks in place.")
@click.option("--docs", "docs_dir", default=None,
              help="The docs tree to process. Default: <folder>/mkdocs/docs.")
@click.option("--check", is_flag=True,
              help="Write nothing; exit 1 if any generated block is out of date.")
@click.option("-q", "--quiet", is_flag=True, help="Only report changes and problems.")
def site(folder, emit, docs_dir, check, quiet):
    mission = os.path.abspath(folder)
    missions = os.path.dirname(mission)
    if not os.path.isdir(mission):
        raise click.ClickException(f"no such folder: {folder}")

    amd_include = _load(missions, mission)

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
