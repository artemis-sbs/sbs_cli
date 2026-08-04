"""`sbs create` - start a new mission from a boilerplate.

This is `fetch` with two extra jobs: pick ONE template folder out of the starter repo, and
resolve which release LINE the new mission should be pinned to.

The line is deliberately a single dial. sbs_utils, LegendaryMissions and OpenUniverse are
released together, so resolving a "highest version" for each independently would happily
produce a combination nobody has ever run. One line, applied to every pin.
"""

import click
import json
import os
import re
import subprocess
import zipfile

from cli_cmd import cli, zipapp_dir
from file_help import fetch_deps, curlretrieve, unzip_subpath
from lib_cmd import lib_get_json, lib_impl
from pathlib import Path

STARTER_USER = "artemis-sbs"
STARTER_REPO = "mast_starter"

# The catalog a branch publishes. Absent, we fall back to "this branch is one minimal
# template at its root" - which is exactly what mast_starter is today, so `create` works
# against the repo unchanged.
CATALOG_FILE = "templates.json"

FALLBACK_TEMPLATE = {
    "id": "minimal",
    "title": "Minimal mission",
    "blurb": "The repository root.",
    "path": ".",
}


# ---------------------------------------------------------------------------
# versions
# ---------------------------------------------------------------------------

_VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:[._-](.+))?$")


def version_key(text):
    """Sort key for a version string, or None if it is not a version.

    Sorts NUMERICALLY, because `v1.10.0` is lexically less than `v1.4.0` and the day that
    starts mattering is the day every default silently picks the wrong line.

    A pre-release suffix sorts BELOW its release, so `v1.4.0_dev` can never win a "highest"
    contest against `v1.4.0`. Dev lines are opt-in via `-b`, never a default.
    """
    if not text:
        return None
    m = _VERSION_RE.match(text.strip())
    if m is None:
        return None
    nums = tuple(int(g) for g in m.groups()[:3])
    pre = m.group(4)
    return (nums, 0 if pre else 1, pre or "")


def highest(versions):
    """The highest parseable version in `versions`, or None."""
    ranked = [(version_key(v), v) for v in versions]
    ranked = [(k, v) for k, v in ranked if k is not None]
    if not ranked:
        return None
    return max(ranked)[1]


def lib_version(filename):
    """The version out of a `__lib__/` artifact name, or None.

    Two shapes are live and both matter here:
      `{user}.{package}.{version}.sbslib`
      `{user}.{repo}.{folder}.{version}.{mastlib|zip}`
    The version itself contains dots, so it is everything between the fixed leading segments
    and the extension - the same slicing `fetch_deps` does.
    """
    parts = filename.split(".")
    if len(parts) < 4:
        return None
    if filename.endswith(".sbslib"):
        return ".".join(parts[2:-1])
    return ".".join(parts[3:-1])


def installed_lines():
    """Release lines this install has an sbs_utils library for, highest first.

    The sbslib is the anchor: a line with no sbslib cannot run a mission at all, however
    many mastlibs are sitting beside it. This is the strongest evidence available locally -
    these libraries were fetched for THIS install and are known to arrive.
    """
    lib_dir = Path(zipapp_dir) / "__lib__"
    found = set()
    if lib_dir.is_dir():
        for entry in lib_dir.iterdir():
            if entry.name.endswith(".sbslib"):
                v = lib_version(entry.name)
                if version_key(v) is not None:
                    found.add(v)
    return sorted(found, key=version_key, reverse=True)


def engine_version_hint():
    """A guess at the installed Cosmos version, from the install folder name.

    `data/missions` lives under something like `Cosmos-1-3-0`. This is a HINT, never a
    hard gate - people rename folders - but it is the only evidence of the ENGINE we have,
    and the engine is what actually constrains us: an sbslib ships inside the mission, but
    it calls a Pybind API that a older engine does not have.
    """
    here = Path(zipapp_dir).resolve()
    for folder in (here, *here.parents):
        # The folder has to actually name Cosmos. Matching any three dotted numbers in any
        # ancestor reads a version out of whatever happens to be in the path - a temp
        # directory named after a UUID once produced "v551.0216.4523".
        if "cosmos" not in folder.name.lower():
            continue
        m = re.search(r"(\d+)[._-](\d+)[._-](\d+)", folder.name)
        if m:
            return f"v{m.group(1)}.{m.group(2)}.{m.group(3)}"
    return None


def retarget_line(deps, line):
    """Re-pin every dependency in a story.json `deps` dict to `line`.

    Returns (new_deps, changes) where changes is a list of (old, new) actually rewritten.
    Every pin moves together or none does - a story.json holding two lines at once is the
    failure this whole command exists to prevent.
    """
    changes = []

    def repin(name):
        old = lib_version(name)
        if old is None or old == line:
            return name
        # Replace the version SEGMENT, not a substring: a repo or folder could contain the
        # same characters.
        parts = name.split(".")
        head = 2 if name.endswith(".sbslib") else 3
        new = ".".join(parts[:head] + line.split(".") + [parts[-1]])
        changes.append((name, new))
        return new

    out = {}
    for key, value in deps.items():
        if key in ("sbslib", "mastlib", "shared_media") and isinstance(value, list):
            out[key] = [repin(n) for n in value]
        elif key == "resources" and isinstance(value, dict):
            out[key] = {k: repin(v) for k, v in value.items()}
        else:
            out[key] = value
    return out, changes


# ---------------------------------------------------------------------------
# github
# ---------------------------------------------------------------------------

def _curl_text(url):
    """GET a small text resource, quietly. None on any failure.

    curl rather than urllib to stay with what the rest of the tool already depends on.
    """
    try:
        r = subprocess.run(["curl", "-fsSL", "--max-time", "20", url],
                           capture_output=True, text=True)
    except FileNotFoundError:
        return None
    if r.returncode != 0:
        return None
    return r.stdout


def _curl_json(url):
    text = _curl_text(url)
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def starter_branches(user, repo):
    """Branch names in the starter repo, or None if GitHub could not be reached."""
    data = _curl_json(f"https://api.github.com/repos/{user}/{repo}/branches?per_page=100")
    if not isinstance(data, list):
        return None
    return [b.get("name") for b in data if isinstance(b, dict) and b.get("name")]


def branch_catalog(user, repo, branch):
    """The templates a branch offers, as a list of dicts.

    A branch with no `templates.json` is not an error: it is the one-template-at-the-root
    layout, which is what the starter repo has always been. Treating that as a catalog of
    one keeps `create` working before the repo grows a single new file.
    """
    url = f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/{CATALOG_FILE}"
    data = _curl_json(url)
    if isinstance(data, dict) and isinstance(data.get("templates"), list):
        out = []
        for t in data["templates"]:
            if isinstance(t, dict) and t.get("id"):
                out.append(t)
        if out:
            return out
    return [dict(FALLBACK_TEMPLATE)]


# ---------------------------------------------------------------------------
# resolution
# ---------------------------------------------------------------------------

def resolve_line(branches, requested, engine_hint, installed):
    """Choose the release line, and say WHY.

    Order of evidence, strongest first:
      1. what the caller asked for            -- never second-guessed
      2. a line this install already has an sbslib for, capped by the engine hint
      3. the engine hint itself
    Deliberately NOT in the list: the highest branch on GitHub. That is the upper bound,
    not a default - handing a brand new author a mission their Cosmos cannot launch is the
    exact failure this command exists to prevent.

    Returns (line, reason) or (None, reason) when there is nothing safe to pick.
    """
    version_branches = [b for b in branches if version_key(b) is not None]

    if requested:
        return requested, "requested"

    if not version_branches:
        # Only `main` exists (today's repo). There is no line to choose between - the
        # branch's own pins stand, unless the caller retargets.
        return None, "the starter repo has no version branches"

    ceiling = version_key(engine_hint) if engine_hint else None
    usable = version_branches
    if ceiling is not None:
        # The ceiling is a ceiling. Falling back to the uncapped list when nothing qualifies
        # would hand a v1.3.0 install a v1.4.0 mission while printing "engine looks like
        # v1.3.0" beside it - the one outcome this is here to prevent.
        usable = [b for b in version_branches if version_key(b) <= ceiling]
        if not usable:
            return None, (f"every line the starter repo offers is newer than this install "
                          f"(looks like {engine_hint})")

    newest = highest(version_branches)
    # Sort here rather than trusting the caller, and drop pre-releases: a `_dev` line is
    # opt-in via `-b`, never something you land on by default.
    candidates = sorted((v for v in installed if version_key(v) and version_key(v)[1]),
                        key=version_key, reverse=True)
    for line in candidates:
        if line in usable:
            if ceiling is not None and line != newest:
                return line, f"newest line this install supports ({engine_hint})"
            return line, "installed in __lib__"

    if engine_hint and engine_hint in usable:
        return engine_hint, "matches the install folder version"

    return None, "could not match a branch to this install"


def choose_template(templates, requested):
    """Return one template dict, prompting when the caller did not name one."""
    if requested:
        for t in templates:
            if t.get("id") == requested:
                return t
        ids = ", ".join(t.get("id", "?") for t in templates)
        raise click.ClickException(f"no template '{requested}'. Available: {ids}")

    if len(templates) == 1:
        return templates[0]

    click.echo("")
    for i, t in enumerate(templates, 1):
        click.echo(f"  {i}) {t.get('id',''):<14} {t.get('title','')}")
        blurb = t.get("blurb")
        if blurb:
            click.echo(f"     {' ':<14} {blurb}")
    click.echo("")
    pick = click.prompt("Template", default="1")
    try:
        idx = int(pick)
        if 1 <= idx <= len(templates):
            return templates[idx - 1]
    except ValueError:
        for t in templates:
            if t.get("id") == pick.strip():
                return t
    raise click.ClickException(f"'{pick}' is not one of the listed templates")


# ---------------------------------------------------------------------------
# writing the mission
# ---------------------------------------------------------------------------

def _bad_title(title):
    """Why `title` cannot go in description.yaml, or None if it is fine.

    description.yaml is read before the mission ever runs, so a value that breaks it takes
    out the whole mission LIST, not just this mission. A dash starts a YAML sequence where a
    scalar is expected; a colon starts a mapping.
    """
    if not title.strip():
        return "the name is empty"
    if title.lstrip().startswith("-"):
        return "a leading '-' makes YAML read it as a list"
    if ":" in title:
        return "a ':' makes YAML read it as a mapping"
    if len(title) > 40:
        return f"it is {len(title)} characters; the mission list truncates long names"
    return None


def _rewrite_line(path, key, value):
    """Replace `key: ...` in a simple YAML file, keeping comments and order.

    A real YAML round-trip would drop every comment in description.yaml, and those comments
    are the documentation a new author reads first.
    """
    if not path.exists():
        return
    out = []
    changed = False
    for text in path.read_text(encoding="utf-8").splitlines():
        stripped = text.lstrip()
        if not changed and stripped.startswith(f"{key}:") and not stripped.startswith("#"):
            indent = text[:len(text) - len(stripped)]
            comment = ""
            after = stripped[len(key) + 1:]
            if "#" in after:
                comment = "  " + after[after.index("#"):]
            out.append(f"{indent}{key}: {value}{comment}")
            changed = True
        else:
            out.append(text)
    if changed:
        path.write_text("\n".join(out) + "\n", encoding="utf-8")


def create_impl(name, template_id, branch, line, title, description, user, repo, retarget,
                assume_yes):
    target = Path(zipapp_dir).resolve() / name

    # Validate before anything is downloaded or written. Discovering a bad name AFTER
    # extraction leaves a half-made mission behind, which is the same trap as the empty
    # folder a mistyped repo used to leave (issue #1).
    for value, flag in ((title, "--title"), (description, "--description")):
        if value is not None:
            why = _bad_title(value)
            if why:
                raise click.ClickException(f"{flag} rejected: {why}")

    # NEVER write into an existing mission. `fetch` refuses to delete a checkout; `create`
    # goes further and refuses to merge into ANY populated folder, because a half-overwritten
    # mission is harder to diagnose than one that was never created.
    if target.exists() and any(target.iterdir()):
        raise click.ClickException(
            f"{target} already exists and is not empty - pick another name, or move it aside")

    branches = starter_branches(user, repo)
    if branches is None:
        raise click.ClickException(
            f"could not reach github.com/{user}/{repo} - check the network, or pass -b")

    engine_hint = engine_version_hint()
    installed = installed_lines()

    if branch is None:
        resolved, reason = resolve_line(branches, line, engine_hint, installed)
        if resolved and resolved in branches:
            branch = resolved
            line = line or resolved
            click.echo(f"Release line: {branch}  ({reason})")
        else:
            # No branch carries that line. Say both halves - printing only the branch reads
            # as "you got what you asked for" when the pins still say something else.
            branch = "main" if "main" in branches else branches[0]
            if resolved:
                click.echo(f"Release line: {resolved} ({reason}), but the starter repo has "
                           f"no '{resolved}' branch - using '{branch}'")
            else:
                click.echo(f"Branch: {branch}  ({reason})")

    templates = branch_catalog(user, repo, branch)
    template = choose_template(templates, template_id)
    sub = template.get("path", ".")

    url = f"https://github.com/{user}/{repo}/archive/refs/heads/{branch}.zip"
    zip_path = str(Path(zipapp_dir).resolve() / "starter.zip")
    click.echo(f"Fetching {repo} ({branch}) from {url}")
    ok = False
    try:
        ok = curlretrieve(url, zip_path)
    except Exception:
        ok = False
    if not ok or not zipfile.is_zipfile(zip_path):
        if os.path.exists(zip_path):
            os.remove(zip_path)
        raise click.ClickException(f"could not download {url}")

    try:
        # The catalog and the other templates are scaffolding of the starter repo, not part
        # of anybody's mission.
        skip = [CATALOG_FILE, ".github/", "mkdocs/", ".env"]
        if sub in (".", "", None):
            skip.append("templates/")
        written = unzip_subpath(zip_path, str(target), sub, skip)
    finally:
        if os.path.exists(zip_path):
            os.remove(zip_path)

    if written == 0:
        raise click.ClickException(
            f"template '{template.get('id')}' points at '{sub}', which is not in {repo}@{branch}")

    click.echo(f"Created {name} from '{template.get('id')}' ({written} files)")

    # ---- identity -------------------------------------------------------
    desc_file = target / "description.yaml"
    if title:
        _rewrite_line(desc_file, "Visible Mission Name", title)
    if description:
        _rewrite_line(desc_file, "Description", description)
    elif title:
        # Leaving the template's own one-liner would put "Mast Mission Template" under every
        # mission anyone ever creates, on the server's mission list.
        _rewrite_line(desc_file, "Description", title)

    # ---- pins -----------------------------------------------------------
    story = target / "story.json"
    deps = {}
    if story.exists():
        try:
            deps = json.loads(story.read_text(encoding="utf-8"))
        except Exception as e:
            raise click.ClickException(f"template's story.json is not valid JSON: {e}")

    shipped = highest([lib_version(n) for n in deps.get("sbslib", [])])
    if retarget and line and shipped and line != shipped:
        deps, changes = retarget_line(deps, line)
        if changes:
            click.echo(f"Re-pinned {len(changes)} dependencies {shipped} -> {line}")
            for old, new in changes:
                click.echo(f"  {old}\n    -> {new}")
        story.write_text(json.dumps(deps, indent=4) + "\n", encoding="utf-8")
        libs = target / "__lib__.json"
        if libs.exists():
            try:
                data = json.loads(libs.read_text(encoding="utf-8"))
                if data.get("version") and data["version"] != line:
                    data["version"] = line
                    libs.write_text(json.dumps(data, indent=4) + "\n", encoding="utf-8")
            except Exception:
                pass
    elif line and shipped and line != shipped:
        click.echo(f"NOTE: template is pinned to {shipped}, not {line}. "
                   f"Pass --retarget to re-pin it.")

    # ---- dependencies ---------------------------------------------------
    click.echo("")
    for pin in deps.get("sbslib", []):
        click.echo(f"  {pin}")
    mastlibs = deps.get("mastlib", [])
    if mastlibs:
        click.echo(f"  + {len(mastlibs)} mastlib dependencies")
    if not assume_yes:
        if not click.confirm("\nFetch these dependencies now?", default=True):
            click.echo(f"Skipped. Run `sbs fetch` inside {name} when you are ready.")
            return

    missing = []
    if deps.get("sbslib"):
        missing += fetch_deps(deps["sbslib"], True, False)
    if mastlibs:
        missing += fetch_deps(mastlibs, False, False)
    resources = deps.get("resources")
    if isinstance(resources, dict):
        missing += fetch_deps(list(resources.values()), False, False)
    if deps.get("shared_media"):
        missing += fetch_deps(deps["shared_media"], False, False)

    # An addon template ships lib folders of its own; a plain mission does not.
    if lib_get_json(name):
        try:
            lib_impl(name, user)
        except Exception as e:
            click.echo(f"WARNING: could not build the template's libraries: {e}")

    if missing:
        click.echo("\nERROR: these dependencies could not be fetched:")
        for dep in dict.fromkeys(missing):
            click.echo(f"  {dep}")
        click.echo(f"{name} will NOT run without them.")
        raise SystemExit(1)

    click.echo(f"\n{name} is ready.")
    click.echo(f"  sbs debug {name}          # run it in the browser")
    click.echo(f"  sbs lint {name}           # check its AMD")


@cli.command(short_help="Create a new mission from a boilerplate template.")
@click.argument("name")
@click.option('-t', '--template', help="Template id. Omit to pick from a list.")
@click.option('-b', '--branch', help="Starter repo branch. Overrides line detection.")
@click.option('-l', '--line', help="Release line to pin to, e.g. v1.4.0. Defaults to the "
                                   "highest line this install already has.")
@click.option('--title', help="Visible mission name. Defaults to the template's.")
@click.option('--description', help="One-line description. Defaults to the title.")
@click.option('--retarget', is_flag=True,
              help="Re-pin the template's dependencies to the resolved line.")
@click.option('-u', '--user', default=STARTER_USER, show_default=True,
              help="Github user/organization holding the starter repo.")
@click.option('-r', '--repo', default=STARTER_REPO, show_default=True,
              help="Starter repository.")
@click.option('-y', '--yes', is_flag=True, help="Do not prompt.")
def create(name, template, branch, line, title, description, retarget, user, repo, yes):
    """Create a new mission NAME from a template in the starter repository."""
    create_impl(name, template, branch, line, title, description, user, repo, retarget, yes)


@cli.command("templates", short_help="List the boilerplate templates available.")
@click.option('-b', '--branch', help="Only show this branch.")
@click.option('-u', '--user', default=STARTER_USER, show_default=True)
@click.option('-r', '--repo', default=STARTER_REPO, show_default=True)
def templates(branch, user, repo):
    """List every template the starter repository offers, per release line."""
    branches = starter_branches(user, repo)
    if branches is None:
        raise click.ClickException(f"could not reach github.com/{user}/{repo}")

    if branch:
        branches = [branch]
    else:
        # Version branches highest first, then everything else (main, dev spikes).
        versioned = sorted([b for b in branches if version_key(b)], key=version_key,
                           reverse=True)
        branches = versioned + [b for b in branches if not version_key(b)]

    engine_hint = engine_version_hint()
    installed = installed_lines()
    resolved, reason = resolve_line(branches, None, engine_hint, installed)
    if resolved:
        click.echo(f"Default release line: {resolved}  ({reason})")
    elif engine_hint:
        click.echo(f"Install looks like {engine_hint}; no matching branch ({reason})")

    for b in branches:
        marker = "  <- default" if b == resolved else ""
        click.echo(f"\n{b}{marker}")
        for t in branch_catalog(user, repo, b):
            click.echo(f"  {t.get('id',''):<14} {t.get('title','')}")
            if t.get("blurb"):
                click.echo(f"  {' ':<14} {t['blurb']}")
