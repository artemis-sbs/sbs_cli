"""Swap which mission set Cosmos loads, by repointing the data/missions link.

A Cosmos install loads exactly one `data/missions` folder. Keeping several sets
side by side as `data/missions_<name>` (converted AMD output, converted MAST
output, the stock set, ...) and making `data/missions` a link to one of them lets
you switch sets without copying anything:

    sbs swap            show the current target and the choices
    sbs swap amd        point data/missions at data/missions_amd
    sbs swap mast       point data/missions at data/missions_mast

Any sibling folder named `missions_<x>` is a valid target, so adding a set is
just creating the folder.

Two things this has to get right, both of which have teeth:

* **Detecting a link.** `os.path.islink()` returns **False** for a junction on
  Windows, and `os.path.isjunction()` only exists on 3.12+. A check built on
  `islink` would classify `data/missions` as a real folder -- and a caller that
  then deleted it recursively would take the whole mission tree with it. See
  :func:`is_link`, which tests the reparse attribute directly.
* **Not standing in the doorway.** `sbs` normally runs with the CWD *inside*
  `data/missions`, i.e. inside the link being replaced, which blocks removing it.
  The command chdirs to the data dir before touching anything.

A real (non-link) `data/missions` is never deleted: it is renamed to
`missions_cos`, which makes it a target like any other (`sbs swap cos`).
"""
import os
import stat

import click

from cli_cmd import cli, zipapp_dir

LINK = "missions"
STOCK = "missions_cos"
PREFIX = "missions_"


def is_link(path):
    """True if `path` is a reparse point -- a symlink OR a junction.

    Not `os.path.islink`: that is False for a junction, which is exactly what
    `mklink /J` (and this command, when not elevated) creates. Junctions and
    directory symlinks are both removed with rmdir and both need this to say yes.
    """
    try:
        st = os.lstat(path)
    except OSError:
        return False
    attrs = getattr(st, "st_file_attributes", None)
    if attrs is None:
        return os.path.islink(path)  # posix
    return bool(attrs & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def link_target(path):
    """Where `path` points, or None if it is not a link."""
    if not is_link(path):
        return None
    try:
        target = os.readlink(path)
    except OSError:
        return None
    if target.startswith("\\\\?\\"):  # junctions report the \\?\ device form
        target = target[4:]
    return target


def link_kind(path):
    """'symlink' | 'junction' | None -- for reporting only."""
    if not is_link(path):
        return None
    tag = getattr(os.lstat(path), "st_reparse_tag", None)
    if tag is None:
        return "symlink"
    return "junction" if tag == stat.IO_REPARSE_TAG_MOUNT_POINT else "symlink"


def targets_in(data):
    """The `missions_*` folders in `data`, sorted."""
    try:
        names = os.listdir(data)
    except OSError:
        return []
    return sorted(n for n in names
                  if n.lower().startswith(PREFIX) and os.path.isdir(os.path.join(data, n)))


def find_data_dir(start):
    """Nearest folder at or above `start` that holds `missions_*` folders.

    Walking up handles the usual invocation, where the CWD is the missions dir
    (or the link itself): `.../data/missions` has no `missions_*` children, its
    parent `.../data` does.
    """
    cur = os.path.abspath(start)
    while True:
        if targets_in(cur):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent


def _make_link(link, target_abs):
    """Create `link` -> `target_abs`, preferring a symlink. Returns the kind made.

    A directory symlink needs admin or Developer Mode; a junction needs neither
    and Cosmos follows it identically, so fall back rather than demanding rights.
    """
    try:
        os.symlink(target_abs, link, target_is_directory=True)
        return "symlink"
    except (OSError, NotImplementedError):
        pass
    if os.name != "nt":
        raise
    import _winapi
    _winapi.CreateJunction(target_abs, link)
    return "junction"


def _print_status(data):
    link = os.path.join(data, LINK)
    click.echo(f"Cosmos data dir: {data}")
    target = link_target(link)
    if target is not None:
        click.echo(f"  {LINK} -> {os.path.basename(target.rstrip(os.sep))}  ({link_kind(link)})")
    elif os.path.isdir(link):
        click.echo(f"  {LINK} is a REAL folder, not a link")
    else:
        click.echo(f"  {LINK} does not exist")
    click.echo("")
    click.echo("Available targets:")
    current = os.path.basename(target.rstrip(os.sep)) if target else None
    for name in targets_in(data):
        click.echo(f"  {'*' if name == current else ' '} {name}")


@cli.command(short_help="Point data/missions at one of the sibling missions_* folders")
@click.argument("target", required=False)
@click.option("--data", "data_opt", default=None,
              help="The Cosmos data folder. Default: found by walking up from the CWD.")
def swap(target, data_opt):
    """Repoint data/missions at the missions_TARGET folder.

    With no TARGET, print the current target and the available ones. TARGET may
    be given with or without the prefix: `amd` and `missions_amd` are the same.

    A real (non-link) data/missions is renamed to missions_cos rather than
    deleted, so `sbs swap cos` brings it back. Close Cosmos first -- a running
    client holds files open under the link.
    """
    data = None
    for start in (data_opt, os.getcwd(), str(zipapp_dir)):
        if start:
            data = find_data_dir(start)
            if data:
                break
    if not data:
        click.echo("ERROR: no Cosmos data folder found (nothing named missions_* "
                   "at or above the current folder). Pass --data.")
        raise SystemExit(2)

    if target is None:
        _print_status(data)
        return

    name = target.strip().strip("/\\")
    if name.lower().startswith(PREFIX):
        name = name[len(PREFIX):]
    wanted = PREFIX + name
    target_abs = os.path.join(data, wanted)
    if not os.path.isdir(target_abs):
        click.echo(f"ERROR: no such target folder: {target_abs}")
        click.echo("")
        _print_status(data)
        raise SystemExit(2)

    # Step out of the link before touching it -- sbs normally runs with the CWD
    # inside data/missions, and a directory in use as a CWD cannot be removed.
    os.chdir(data)
    link = os.path.join(data, LINK)

    if os.path.lexists(link):
        if is_link(link):
            try:
                os.rmdir(link)  # removes the link only, never its contents
            except OSError as e:
                click.echo(f"ERROR: could not remove the existing link: {e}")
                click.echo("       Is Cosmos running, or a shell sitting in data/missions?")
                raise SystemExit(1)
        else:
            stock = os.path.join(data, STOCK)
            if os.path.exists(stock):
                click.echo(f"ERROR: {link} is a REAL folder, not a link, and {STOCK} "
                           "already exists,")
                click.echo("       so it cannot be moved aside. Nothing has been changed.")
                raise SystemExit(1)
            try:
                os.rename(link, stock)
            except OSError as e:
                click.echo(f"ERROR: could not move {LINK} aside: {e}")
                click.echo("       Is Cosmos running, or a shell sitting in data/missions?")
                raise SystemExit(1)
            click.echo(f"Kept the existing real folder: {LINK} -> {STOCK} "
                       f'(swap back with "sbs swap cos")')

    try:
        kind = _make_link(link, target_abs)
    except OSError as e:
        click.echo(f"ERROR: could not create the link: {e}")
        click.echo("       The old link is already gone -- re-run once the cause is fixed.")
        raise SystemExit(1)

    click.echo(f"Switched: {LINK} -> {wanted}  ({kind})")
    click.echo("")
    _print_status(data)
