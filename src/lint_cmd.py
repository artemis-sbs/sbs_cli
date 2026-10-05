import click
import os
import sys
import glob
import json
import re
import zipfile

from cli_cmd import cli, zipapp_dir
from compile_cmd import sbs_lib_import


def _prefer_working_tree_sbs_utils(missions, mission):
    """If a working-tree `sbs_utils/` package sits beside the missions (dev
    machine), put it first on sys.path so the linter runs the latest code
    (which may not be in the packaged sbslib yet). Mirrors --use-working-tree.
    Checks both the tool's missions dir and the mission's own parent, so it works
    whether invoked from the packaged pyz or a source path."""
    bases = [missions, os.path.dirname(os.path.abspath(mission))]
    for base in bases:
        wt = os.path.join(base, "sbs_utils")
        if os.path.isdir(os.path.join(wt, "sbs_utils")):
            sys.path.insert(0, wt)
            return


def _ensure_sbs_utils_importable(missions):
    """Make `import sbs_utils` work for a standalone launch (e.g. `sbs lint --lsp`,
    with no mission to declare a sbslib). Prefer a working tree; otherwise add a
    released `sbs_utils` sbslib from `__lib__` (a zip Python imports directly)."""
    _prefer_working_tree_sbs_utils(missions, missions)
    try:
        import sbs_utils  # noqa: F401
        return
    except Exception:
        pass
    libs = _sbs_utils_sbslibs(os.path.join(missions, "__lib__"))
    if libs:
        sys.path.append(libs[0])


def _sbs_utils_sbslibs(lib_dir):
    """The sbs_utils libraries in `lib_dir` that ARE libraries, newest name first.

    A failed download is a file too. The game's own archive ships
    `artemis-sbs.sbs_utils.v1.4.0_dev.sbslib` holding the nine bytes `Not Found`, and its
    name sorts above the real one - so on a fresh install the library "was not
    importable" and the editor's checking would not start."""
    import zipfile
    return [p for p in sorted(glob.glob(os.path.join(lib_dir, "*sbs_utils*.sbslib")),
                              reverse=True)
            if zipfile.is_zipfile(p)]


def _load_amd_lint(missions, mission):
    """Import `amd_lint` - working tree first, else the mission's own sbslib."""
    _prefer_working_tree_sbs_utils(missions, mission)
    sys.path.insert(0, mission)
    try:
        from sbs_utils.procedural.amd_lint import amd_lint
    except Exception:
        # Fall back to the libraries the mission itself declares.
        sbs_lib_import(missions, mission)
        from sbs_utils.procedural.amd_lint import amd_lint
    # AFTER sbs_utils resolves (the registration imports amd_schema) and before any
    # file is linted, so the mission's own words are declared when checking starts.
    _load_mission_vocabulary(mission)
    return amd_lint


def _load_mission_vocabulary(mission):
    """Delegates to sbs_utils.procedural.amd_vocab.

    The implementation moved into the LIBRARY so that `sbs lint` and the headless
    `--test` gate in cosmos_dev share one copy. Two copies would drift, and the
    drift is not subtle: without this step amd_lint reports 174 false
    `unknown-field` warnings on the shipped corpus instead of 2.

    Callers must have run _prefer_working_tree_sbs_utils / _load_amd_lint first, so
    sbs_utils is importable by the time this runs.
    """
    from sbs_utils.procedural.amd_vocab import load_mission_vocabulary
    return load_mission_vocabulary(mission)


def _shared_folder_owner(missions, folder):
    """The mission that reads `folder`, when `folder` is a shared one (an author's own
    files under `common_data`), else None. Needs an sbs_utils that knows the idea."""
    _prefer_working_tree_sbs_utils(missions, folder)
    try:
        _ensure_sbs_utils_importable(missions)
        from sbs_utils.procedural.amd_vocab import shared_folder_owner
    except Exception:
        return None
    return shared_folder_owner(os.path.join(os.path.abspath(folder), "x.amd"))


def _shared_amd_files(mission):
    """The `.amd` files in the shared folders this mission reads. [] on an older
    sbs_utils."""
    try:
        from sbs_utils.procedural.amd_vocab import shared_amd_files
    except Exception:
        return []
    return shared_amd_files(mission)


def _declared_addon_paths(mission_root):
    """Delegates to sbs_utils.procedural.amd_vocab (see _load_mission_vocabulary)."""
    from sbs_utils.procedural.amd_vocab import declared_addon_paths
    return declared_addon_paths(mission_root)


def _library_mast_globals():
    """Function names `sbs_utils.procedural` registers as MAST globals.

    Mirrors register_mission_functions' own filter (`func.__module__ == mod.__name__`)
    so a re-export is not counted as a library global. Best-effort: on any failure the
    shadow check is simply skipped rather than reporting nonsense.
    """
    names = set()
    try:
        import pkgutil, importlib
        from inspect import getmembers, isfunction
        import sbs_utils.procedural as proc
        for mi in pkgutil.iter_modules(proc.__path__):
            try:
                mod = importlib.import_module("sbs_utils.procedural." + mi.name)
            except Exception:
                continue
            for fname, func in getmembers(mod, isfunction):
                if getattr(func, "__module__", None) == mod.__name__ and not fname.startswith("_"):
                    names.add(fname)
    except Exception:
        return set()
    return names


def _mast_global_names():
    """Every name in `MastGlobals.globals` once the library has registered itself.

    That table is exactly what `core_nodes/assign.py` refuses a hard assignment to
    ("Variable assignment to a keyword"), which compiles the whole story to 0 labels. It
    is wider than `_library_mast_globals` - it includes the `procedural.gui` package
    re-exports and MAST's own builtins. Registering needs an `sbs` module; outside the
    engine that is the cosmos_dev mock when it can be found. Best-effort: on any failure
    the library half of the check is skipped rather than reporting nonsense.
    """
    try:
        if "sbs" not in sys.modules:
            try:
                import cosmos_dev.mock.sbs as _mock_sbs
                sys.modules["sbs"] = _mock_sbs
            except Exception:
                return set()
        from sbs_utils.mast_sbs import mast_sbs_procedural  # noqa: F401 - registers
        from sbs_utils.mast.mast_globals import MastGlobals
        return set(MastGlobals.globals)
    except Exception:
        return set()


def _load_signal_lint(missions, mission):
    """Import `signal_lint` - working tree first, else the mission's own sbslib."""
    _prefer_working_tree_sbs_utils(missions, mission)
    sys.path.insert(0, mission)
    try:
        from sbs_utils.procedural.signal_lint import signal_lint
        return signal_lint
    except Exception:
        sbs_lib_import(missions, mission)
        from sbs_utils.procedural.signal_lint import signal_lint
        return signal_lint


def _load_await_lint(missions, mission):
    """Import `await_lint` - working tree first, else the mission's own sbslib.

    Returns None when the mission's sbs_utils predates the rule."""
    _prefer_working_tree_sbs_utils(missions, mission)
    sys.path.insert(0, mission)
    try:
        from sbs_utils.procedural.await_lint import await_lint
        return await_lint
    except Exception:
        try:
            sbs_lib_import(missions, mission)
            from sbs_utils.procedural.await_lint import await_lint
            return await_lint
        except Exception:
            return None


def _load_reach_lint(missions, mission):
    """Import `reach_lint` (a line that can never run because the label already ended).

    Returns None when the mission's sbs_utils predates the rule."""
    _prefer_working_tree_sbs_utils(missions, mission)
    try:
        from sbs_utils.procedural.reach_lint import reach_lint
        return reach_lint
    except Exception:
        return None


# The compiler prints one of its own errors as `Error: ...` and one that Python raised
# while reading a line as `Exception: ...` - an unclosed quote is the common one. Only
# the first was matched, so that one came out as `line 1: FAILED: 1 compile error(s)`
# with the real line thrown away.
_COMPILE_ERROR = re.compile(r"^(?:Error|Exception): (?P<what>.*)$")
# What `sbs compile` says when THIS MACHINE cannot compile anything: the dev library
# that carries the stand-in for the game is fetched by `sbs debug`, and a writer who has
# only ever linted does not have it. That is not a fault in the mission.
_COMPILE_CANNOT = ("Missing dev libraries", "No sbs_utils source and no sbs_utils sbslib")
NOT_CHECKED = "not-checked"
_COMPILE_AT = re.compile(r"^at (?P<file>.+?) Line (?P<line>\d+) - (?P<text>.*)$")


def _compile_errors(folder, mission):
    """Compile the mission's story in a CHILD process and return its errors as
    [(file relative to the mission, line, message)].

    A story that does not compile runs NOTHING - no map, no ships, both logs empty - and
    `sbs lint` said `clean`, because it never compiled anything. A writer has two tools,
    lint and playing; this is the failure where playing shows a blank screen and lint
    showed a green one.

    A child process, not a call: compiling imports the mission's `script.py` and
    registers its routes, which a lint run that goes on to other passes should not have
    done to it. Returns None when it cannot be run at all (a source checkout with no
    zipapp to re-enter).
    """
    import subprocess
    app = os.path.abspath(sys.argv[0]) if sys.argv and sys.argv[0] else ""
    if not (os.path.isfile(app) and app.lower().endswith(".pyz")):
        return None
    try:
        run = subprocess.run([sys.executable, app, "compile", folder],
                             capture_output=True, text=True, timeout=300)
    except Exception:
        return None
    out = (run.stdout or "").splitlines()
    if run.returncode == 0 and not any(l.startswith("FAILED:") for l in out):
        return []
    if any(l.startswith(_COMPILE_CANNOT) for l in out):
        return NOT_CHECKED
    errors = []
    for i, line in enumerate(out):
        m = _COMPILE_ERROR.match(line.strip())
        if not m:
            continue
        what, where, number = m.group("what").strip(), "story.mast", 1
        at = _COMPILE_AT.match(out[i + 1].strip()) if i + 1 < len(out) else None
        if at:
            number = int(at.group("line"))
            try:
                where = os.path.relpath(at.group("file"), mission)
            except ValueError:
                where = at.group("file")
            what = f"{what}: {at.group('text')}"
        errors.append((where, number, what))
    if not errors:
        # It failed and said so in a shape this does not know. Still a failure.
        tail = " ".join(l.strip() for l in out[-3:] if l.strip()) or "the compile failed"
        errors.append(("story.mast", 1, tail))
    return errors


def _load_blob_lint(missions, mission):
    """Import `blob_lint` - working tree first, else the mission's own sbslib.

    Returns None when the mission's sbs_utils predates the rule, so linting an older
    mission still works instead of dying on the import.
    """
    _prefer_working_tree_sbs_utils(missions, mission)
    sys.path.insert(0, mission)
    try:
        from sbs_utils.procedural.blob_lint import blob_lint
        return blob_lint
    except Exception:
        try:
            sbs_lib_import(missions, mission)
            from sbs_utils.procedural.blob_lint import blob_lint
            return blob_lint
        except Exception:
            return None


def _load_tilemap_lint(missions, mission):
    """Import `tilemap_lint_mission` - working tree first, else the mission's own sbslib.

    Returns None when the mission's sbs_utils predates tile maps."""
    _prefer_working_tree_sbs_utils(missions, mission)
    sys.path.insert(0, mission)
    try:
        from sbs_utils.procedural.tilemap_lint import tilemap_lint_mission
        return tilemap_lint_mission
    except Exception:
        try:
            sbs_lib_import(missions, mission)
            from sbs_utils.procedural.tilemap_lint import tilemap_lint_mission
            return tilemap_lint_mission
        except Exception:
            return None


def lint_self_packaging(mission, user="artemis-sbs"):
    """Check a repo that ships its OWN addons keeps its three lists in step.

    An addon a repo packages is named in three places, and they must agree:

      __lib__.json    what gets built into a .mastlib
      story.json      what a FETCHED copy loads from __lib__
      .gitattributes  export-ignore, so a fetched copy has no source to load instead

    Miss story.json and the fetched copy silently has no addon. Miss the export-ignore
    and the fetched copy keeps the source, which then wins over the lib - so the release
    artifact is never actually exercised. Both fail on someone else's machine, not here.

    Only applies once a repo has ADOPTED the pattern (its story.json already declares at
    least one of its own addons); a repo that ships source only is left alone.

    Returns a list of (severity, message).
    """
    out = []
    try:
        with open(os.path.join(mission, "__lib__.json")) as f:
            lib = json.load(f) or {}
    except Exception:
        return out
    addons = lib.get("mastlib") or []
    version = lib.get("version")
    if not addons or not version:
        return out
    repo = os.path.basename(os.path.abspath(mission))
    try:
        with open(os.path.join(mission, "story.json")) as f:
            declared = set((json.load(f) or {}).get("mastlib") or [])
    except Exception:
        declared = set()

    expected = {a: f"{user}.{repo}.{a}.{version}.mastlib" for a in addons}
    if not (declared & set(expected.values())):
        return out          # has not adopted the pattern; nothing to keep in step

    missing = [a for a, name in expected.items() if name not in declared]
    if missing:
        out.append(("error", "story.json does not declare " + str(len(missing)) +
                    " of this repo's own addons, so a fetched copy loads nothing for "
                    "them: " + ", ".join(sorted(missing))))
    try:
        with open(os.path.join(mission, ".gitattributes")) as f:
            attrs = f.read()
    except Exception:
        attrs = ""
    unignored = [a for a in addons
                 if not any(line.split()[0].rstrip("/") == a and "export-ignore" in line
                            for line in attrs.splitlines() if line.split())]
    if unignored:
        out.append(("error", ".gitattributes does not export-ignore " + str(len(unignored)) +
                    " packaged addon(s), so a fetched copy keeps their source and it "
                    "wins over the declared lib: " + ", ".join(sorted(unignored))))
    return out


def _read_text(path):
    """A source file's text, decoded the way the game decodes it: UTF-8 (a mark is
    fine), UTF-16 with its mark, else the Windows code page.

    These reads used a bare `open(path, "r")` - the locale's code page - inside an
    `except: pass`. So a UTF-8 file with one curly quote in it could not be read on some
    machines, was skipped without a word, and every key in it went missing from the
    table that cross-file references are checked against.

    Line ends come back as a text-mode open gave them: a Windows file is CRLF on
    disk, and every pattern here is written against a bare newline."""
    return _decode(path).replace(chr(13) + chr(10), chr(10))


def _decode(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        try:
            return data.decode("utf-16")
        except UnicodeDecodeError:
            pass
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


def _read_all(mission, pattern):
    """Read every file matching `pattern` under `mission` into a list of strings."""
    out = []
    for path in glob.glob(os.path.join(mission, "**", pattern), recursive=True):
        try:
            out.append(_read_text(path))
        except Exception:
            pass
    return out


# A file name handed straight to a call: `crew_load_amd("mission.amd")`. No spaces in
# the name (a sentence that mentions a file is not a request for it), and not a call
# that says in its own name that the file may be absent.
_AMD_NAMED = re.compile(r"""(?P<call>\w+)\(\s*["'](?P<name>[\w./\\-]+\.amd)["']""")
_AMD_MAY_BE_ABSENT = re.compile(r"optional|exists|isfile|expect|print|log", re.I)


def _missing_amd_files(mission, mast_files):
    """[(file relative to the mission, line, message)] for each `.amd` a `.mast` names
    that is not there.

    The story asks for its files BY NAME (`crew_load_amd("mission.amd")`). Rename the
    file, or let Notepad save it as `mission.amd.txt`, and lint said `clean` - about the
    renamed file, or about nothing at all - while the game stopped on its first line
    with a Python traceback in the log."""
    out = []
    said = {}                # (file, name) -> index in `out`: one finding per missing file
    root = os.path.abspath(mission)
    for path in mast_files:
        try:
            lines = _read_text(path).splitlines()
        except Exception:
            continue
        here = os.path.dirname(os.path.abspath(path))
        for number, line in enumerate(lines, start=1):
            code = line.split("#", 1)[0]
            if "{" in code and "}" in code:
                continue                       # a name built at run time: cannot tell
            for m in _AMD_NAMED.finditer(code):
                if _AMD_MAY_BE_ABSENT.search(m.group("call")):
                    continue
                name = m.group("name").strip()
                spots = [os.path.join(root, name), os.path.join(here, name),
                         os.path.join(os.path.dirname(root), name)]
                if any(os.path.isfile(s) for s in spots):
                    continue
                if (path, name) in said:
                    rel, first, message = out[said[(path, name)]]
                    more = ", " if ". Also asked for on line " in message \
                        else ". Also asked for on line "
                    out[said[(path, name)]] = (rel, first, message + f"{more}{number}")
                    continue
                said[(path, name)] = len(out)
                base = os.path.basename(name)
                near = sorted(f for f in os.listdir(os.path.dirname(spots[0]) or root)
                              if f != base and f.lower().startswith(base.lower())) \
                    if os.path.isdir(os.path.dirname(spots[0]) or root) else []
                others = sorted(os.path.relpath(p, root) for p in glob.glob(
                    os.path.join(root, "*.amd")))
                hint = ""
                if near:
                    hint = (f". There is a `{near[0]}` in the folder: the name has to END "
                            f"in `.amd` (Windows may be hiding the last part)")
                elif others:
                    hint = f". The folder has: {', '.join(others[:4])}"
                out.append((os.path.relpath(path, root), number,
                            f"this line asks for `{name}`, and there is no file of that "
                            f"name. The game stops here when the mission starts{hint}"))
    return out


def _mission_amd_keys(amd_files):
    """Union of every node key across all of a mission's .amd files - the symbol
    table cross-file references resolve against."""
    from sbs_utils.procedural.amd_core import parse
    keys = set()
    for path in amd_files:
        try:
            keys |= parse(_read_text(path)).keys
        except Exception:
            pass
    return keys


def _mastlib_signal_source(missions, mission):
    """The signal-relevant lines from the mission's mastlibs: `//signal/...` route
    declarations AND emit sites (`signal_emit(...)` / `SIGNAL_NAME`).

    So the cross-file checks know about signals routed *or* emitted in LM/OU addons
    (not just the mission's own source) and don't false-positive. Reads story.json's
    `mastlib` list and scans those zips (.mast + .py) in the shared `__lib__`
    folder; returns one source string of the relevant lines (or None). Best-effort -
    missing story.json / unbuilt libs are skipped silently."""
    story = os.path.join(mission, "story.json")
    if not os.path.isfile(story):
        return None
    try:
        with open(story) as f:
            data = json.load(f)
    except Exception:
        return None
    lib_dirs = [os.path.join(missions, "__lib__"),
                os.path.join(os.path.dirname(os.path.abspath(mission)), "__lib__")]

    def relevant(ln):
        s = ln.lstrip()
        return s.startswith("//signal/") or "signal_emit" in ln or "SIGNAL_NAME" in ln

    lines = []
    for name in (data.get("mastlib") or []):
        for lib_dir in lib_dirs:
            zpath = os.path.join(lib_dir, name)
            if not os.path.isfile(zpath):
                continue
            try:
                with zipfile.ZipFile(zpath) as z:
                    for entry in z.namelist():
                        if not (entry.endswith(".mast") or entry.endswith(".py")):
                            continue
                        text = z.read(entry).decode("utf-8", "replace")
                        lines += [ln for ln in text.splitlines() if relevant(ln)]
            except Exception:
                continue
            break  # found this lib; don't re-read from the other dir
    return "\n".join(lines) if lines else None


def _report_missing(missions, mission, amd_files, known_keys, fmt):
    """`sbs lint --missing`: everything referenced but not written yet.

    The same facts the linter reports as `dangling-*` warnings, turned into a WORK
    LIST. Drafting a story as prose with `[[links]]` to records that do not exist is
    a supported way to work, so this is deliberately not a failure - it always exits
    0 and it says what to write next, grouped by target rather than by file."""
    _prefer_working_tree_sbs_utils(missions, mission)
    sys.path.insert(0, mission)
    try:
        from sbs_utils.procedural import amd_core
        from sbs_utils.procedural.amd_lint import amd_lint_missing
    except Exception as e:
        print(f"ERROR: could not load sbs_utils ({e})")
        return 2

    # target -> [(kind, owner, file, line)]
    found = {}
    for path in amd_files:
        rel = os.path.relpath(path, mission)
        try:
            doc = amd_core.parse(None, file_path=path)
        except Exception:
            continue
        for target, uses in amd_lint_missing(doc, known_keys).items():
            for kind, owner, span in uses:
                found.setdefault(target, []).append((kind, owner, rel, span.line))

    if fmt == "json":
        print(json.dumps([{"target": t,
                           "uses": [{"kind": k, "owner": o, "file": f, "line": ln}
                                    for k, o, f, ln in sorted(u)]}
                          for t, u in sorted(found.items())], indent=1))
        return 0

    if not found:
        print("Nothing missing - every reference resolves.")
        return 0

    _KIND_WORD = {"link": "linked from", "cue": "spoken by", "choice": "chosen from",
                  "scene": "scene of", "reveal": "revealed by", "parent": "parent of"}
    print(f"{len(found)} thing(s) referenced but not written yet:\n")
    for target, uses in sorted(found.items()):
        print(f"  {target}")
        for kind, owner, rel, line in sorted(uses):
            word = _KIND_WORD.get(kind, kind)
            print(f"      {word} `{owner}`   {rel}:{line}")
    return 0


def _addon_py_sources(mission):
    """[(rel, text)] for every non-test .py under an addon (a dir with __init__.mast)."""
    out = []
    for ini in sorted(glob.glob(os.path.join(mission, "*", "__init__.mast"))):
        d = os.path.dirname(ini)
        for path in sorted(glob.glob(os.path.join(d, "**", "*.py"), recursive=True)):
            if os.path.basename(path).startswith("test_"):
                continue
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    out.append((os.path.relpath(path, mission), fh.read()))
            except OSError:
                continue
    return out


def _report_private(mission, fmt):
    """`--private`: public addon defs used only in their own file. Always exits 0."""
    try:
        import sbs_utils
        from sbs_utils.procedural.namespace_lint import namespace_lint_private_candidates
    except Exception as e:
        print(f"ERROR: this sbs_utils has no --private support ({e})")
        return 2
    py_sources = _addon_py_sources(mission)
    mine = {rel for rel, _ in py_sources}
    refs = []
    for ext in ("py", "mast", "amd", "yaml", "json"):
        for path in glob.glob(os.path.join(mission, "**", "*." + ext), recursive=True):
            rel = os.path.relpath(path, mission)
            if rel in mine or os.path.basename(path).startswith("test_"):
                continue
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    refs.append((rel, fh.read()))
            except OSError:
                continue
    lib_words = set()
    lib_root = os.path.dirname(sbs_utils.__file__)
    for path in glob.glob(os.path.join(lib_root, "**", "*.*"), recursive=True):
        if os.path.splitext(path)[1] not in (".py", ".mast"):
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                lib_words.update(re.findall(r"[A-Za-z_]\w*", fh.read()))
        except OSError:
            continue
    found = namespace_lint_private_candidates(py_sources, refs, lib_words)
    by_file = {}
    for rel, f in found:
        by_file.setdefault(rel, []).append(f)
    bundle = []
    for rel in sorted(by_file):
        if fmt == "text":
            print(f"== {rel} ==")
            for f in by_file[rel]:
                print(f"  {f}")
        elif fmt == "compact":
            for f in by_file[rel]:
                print(f.compact(rel))
        else:
            bundle.extend(f.to_dict(file=rel) for f in by_file[rel])
    if fmt == "json":
        import json
        print(json.dumps(bundle, indent=2))
    elif fmt == "text":
        print(f"\n{len(found)} public function(s) in {len(by_file)} file(s) could be private")
    return 0


@cli.command(short_help="Validate a mission's AMD (.amd) files")
@click.argument("folder", default=".")
@click.option("--strict", is_flag=True, help="Exit non-zero on warnings too (not just errors).")
@click.option("--no-cross", is_flag=True,
              help="Skip cross-file checks (signal->//signal route, reach->landmark).")
@click.option("--no-signals", is_flag=True,
              help="Skip the .mast //signal side-effect checks (per-console duplication).")
@click.option("--format", "fmt", type=click.Choice(["text", "compact", "json"]),
              default="text", help="Output format: text (human), compact "
              "(file:line:col: for editor problem-matchers), or json (tools/CI).")
@click.option("--lsp", is_flag=True,
              help="Run as an AMD language server (LSP over stdio) for editors.")
@click.option("--missing", is_flag=True,
              help="List what is REFERENCED but not written yet, grouped by target, "
                   "and exit 0. A work list, not a failure.")
@click.option("--no-compile", "no_compile", is_flag=True,
              help="Skip the check that story.mast compiles.")
@click.option("--private", "private", is_flag=True,
              help="List public addon functions nothing outside their own file uses "
                   "(candidates for a leading underscore), and exit 0. A work list.")
def lint(folder, strict, no_cross, no_signals, fmt, lsp, missing, private, no_compile):
    """Lint a mission FOLDER: its .amd files AND its .mast signal routes.

    AMD: structural problems (broken headings, unclosed `---` fences, heading-level
    jumps) are ERRORs and fail the run; dangling references (choice/Scene/reveal
    targets, emitted signals with no route, reach cells with no landmark) are WARNINGs.

    MAST signals: a `//signal` route whose body SPAWNS / applies a MODIFIER / changes
    QUEST state / SAVES / rolls RANDOM runs once PER CONNECTED CONSOLE (only
    `//shared/signal` is server-once), so it duplicates - flagged as a WARNING. See
    SIGNAL_ROUTING.md. Skip with --no-signals.

    Exit code: 1 if any error (or any finding under --strict), else 0.

    With --lsp, run an editor language server on stdin/stdout instead (VSCode,
    Neovim, Emacs, ...): live diagnostics as you type.
    """
    # A CHECK LEAVES THE MISSION'S LOGS ALONE. Lint builds a Mast to read the story, and
    # that used to empty `mast.runtime.log` - the file a writer runs lint and then goes
    # to read. The child process that compiles the story inherits this.
    os.environ["MAST_LEAVE_LOGS"] = "1"
    # A FINDING QUOTES WHAT THE WRITER TYPED, and what they typed may be a character the
    # output cannot hold: with lint's output going to a file or to an editor's task
    # runner it is the Windows code page, and one emoji in a mission file was a
    # traceback out of `print` instead of the finding about the emoji.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="backslashreplace")
        except Exception:
            pass
    missions = zipapp_dir

    if lsp:
        # The server lives in sbs_utils; make it importable (working tree, else a
        # released sbslib from __lib__), then hand stdio over to it.
        _ensure_sbs_utils_importable(missions)
        sys.path.insert(0, missions)
        try:
            from sbs_utils.procedural.amd_lsp import serve
        except Exception as e:
            print(f"ERROR: could not load the AMD language server ({e})")
            raise SystemExit(2)
        raise SystemExit(serve())

    if folder in (".", "", "./", ".\\"):
        # NO FOLDER NAME. `os.path.join(missions, ".")` is the missions folder itself, so
        # this linted EVERY mission on the machine as if they were one, and wrote two log
        # files into the missions folder. It means "the mission I am standing in".
        here = os.getcwd()
        if not any(os.path.isfile(os.path.join(here, name))
                   for name in ("story.mast", "story.json", "script.py")):
            print("ERROR: which mission? Put its folder name after the command:\n"
                  "    sbs lint MyMission")
            raise SystemExit(2)
        try:
            folder = os.path.relpath(here, str(missions))
        except ValueError:
            folder = here
        if folder.startswith(".."):
            folder = here
    mission = os.path.join(missions, folder)
    if not os.path.isdir(mission):
        mission = folder  # allow an absolute or cwd-relative path
    if not os.path.isdir(mission):
        print(f"ERROR: not a folder: {folder}")
        raise SystemExit(2)

    # A SHARED folder (`common_data/bosses`) is not a mission, but its files are written
    # in one mission's words. Lint them as part of that mission, and only them.
    only_shared = None
    owner = _shared_folder_owner(missions, mission)
    if owner:
        only_shared = os.path.abspath(mission)
        mission = owner

    try:
        amd_lint = _load_amd_lint(missions, mission)
        signal_lint = None if no_signals else _load_signal_lint(missions, mission)
        blob_lint = _load_blob_lint(missions, mission)
        await_lint = _load_await_lint(missions, mission)
        reach_lint = _load_reach_lint(missions, mission)
        tilemap_lint_mission = _load_tilemap_lint(missions, mission)
    except Exception as e:
        print(f"ERROR: could not load sbs_utils to lint ({e})")
        raise SystemExit(2)

    amd_files = sorted(glob.glob(os.path.join(mission, "**", "*.amd"), recursive=True))
    # ...and the shared folders this mission reads: an author's own files, kept outside
    # the mission folder so an update does not delete them.
    shared_files = _shared_amd_files(mission)
    amd_files += shared_files
    mast_files = [] if no_signals else sorted(
        glob.glob(os.path.join(mission, "**", "*.mast"), recursive=True))
    if only_shared:
        # Cross-file references still resolve against the whole mission (known_keys and
        # mast_sources below are built before this narrows anything that feeds them).
        no_signals = True
        mast_files = []
    if not amd_files and not mast_files:
        if fmt == "json":
            print("[]")
        else:
            print(f"No .amd or .mast files under {mission}")
        return

    mast_sources = None
    if not no_cross:
        mast_sources = _read_all(mission, "*.mast") + _read_all(mission, "*.py")
        mastlib_sig = _mastlib_signal_source(missions, mission)
        if mastlib_sig:
            mast_sources.append(mastlib_sig)

    # Mission-wide symbol table so cross-file references (a Scene/choice/reveal in
    # one .amd pointing at a node in another) don't false-positive as dangling.
    known_keys = _mission_amd_keys(amd_files)
    if only_shared:
        inside = os.path.normcase(only_shared) + os.sep
        amd_files = [p for p in amd_files
                     if os.path.normcase(os.path.abspath(p)).startswith(inside)]

    shared_set = {os.path.normcase(os.path.abspath(p)) for p in shared_files}

    def _rel(path):
        # A shared file is named from the missions folder (`common_data/bosses/x.amd`),
        # not as a climb out of the mission (`../common_data/...`).
        if os.path.normcase(os.path.abspath(path)) in shared_set:
            return os.path.relpath(path, os.path.dirname(os.path.abspath(mission)))
        return os.path.relpath(path, mission)

    if missing:
        raise SystemExit(_report_missing(missions, mission, amd_files, known_keys, fmt))

    if private:
        raise SystemExit(_report_private(mission, fmt))

    total_err = total_warn = 0
    bundle = []

    # Packaging drift: a repo shipping its own addons must keep __lib__.json, story.json
    # and .gitattributes in step, or a FETCHED copy is quietly wrong.
    packaging = [] if only_shared else lint_self_packaging(mission)
    for severity, message in packaging:
        if severity == "error":
            total_err += 1
        else:
            total_warn += 1
        if fmt == "text":
            print(f"== packaging ==\n  [{severity.upper()}] {message}")
        elif fmt == "compact":
            print(f"__lib__.json:1:1: {severity}: {message}")
        else:
            bundle.append({"file": "__lib__.json", "line": 1, "severity": severity,
                           "code": "packaging-drift", "message": message})

    for path in amd_files:
        findings = amd_lint(file_path=path, mast_sources=mast_sources,
                            cross_file=not no_cross, known_keys=known_keys)
        rel = _rel(path)
        for f in findings:
            if f.is_error():
                total_err += 1
            else:
                total_warn += 1
        if fmt == "text":
            print(f"== {rel} ==")
            if not findings:
                print("  clean")
            for f in findings:
                print(f"  {f}")
        elif fmt == "compact":
            for f in findings:
                print(f.compact(rel))
        else:  # json
            bundle.extend(f.to_dict(file=rel) for f in findings)

    # MAST data_set pass: a blob read compared or `in`-tested with no None guard, and
    # the await pass: a statement directly in an `await ...:` block (it never runs).
    # Same printing rule as the signal pass below - only files WITH findings.
    per_file_mast = [r for r in (blob_lint, await_lint, reach_lint) if r is not None]
    if per_file_mast:
        for path in mast_files:
            findings = []
            for rule in per_file_mast:
                findings += rule(file_path=path)
            findings.sort(key=lambda f: f.line)
            if not findings:
                continue
            rel = os.path.relpath(path, mission)
            for f in findings:
                if f.is_error():
                    total_err += 1
                else:
                    total_warn += 1
            if fmt == "text":
                print(f"== {rel} ==")
                for f in findings:
                    print(f"  {f}")
            elif fmt == "compact":
                for f in findings:
                    print(f.compact(rel))
            else:  # json
                bundle.extend(f.to_dict(file=rel) for f in findings)

    # MAST signal-route pass: side-effects in a //signal route (per-console duplication).
    # Only files WITH findings are printed (a mission has many clean .mast files).
    if signal_lint is not None:
        for path in mast_files:
            findings = signal_lint(file_path=path)
            if not findings:
                continue
            rel = os.path.relpath(path, mission)
            for f in findings:
                if f.is_error():
                    total_err += 1
                else:
                    total_warn += 1
            if fmt == "text":
                print(f"== {rel} ==")
                for f in findings:
                    print(f"  {f}")
            elif fmt == "compact":
                for f in findings:
                    print(f.compact(rel))
            else:  # json
                bundle.extend(f.to_dict(file=rel) for f in findings)

        # Whole-mission pass: an init signal that spawns unkeyed AND is emitted from
        # more than one place. Needs every file at once, so it cannot live in the
        # per-file loop above.
        try:
            from sbs_utils.procedural.signal_lint import signal_lint_project
        except Exception:
            signal_lint_project = None
        if signal_lint_project is not None:
            sources = []
            for path in mast_files:
                try:
                    with open(path, "r", encoding="utf-8", errors="replace") as fh:
                        sources.append((os.path.relpath(path, mission), fh.read()))
                except OSError:
                    continue
            project = signal_lint_project(sources)
            by_file = {}
            for rel, f in project:
                by_file.setdefault(rel, []).append(f)
                if f.is_error():
                    total_err += 1
                else:
                    total_warn += 1
            for rel, findings in by_file.items():
                if fmt == "text":
                    print(f"== {rel} ==")
                    for f in findings:
                        print(f"  {f}")
                elif fmt == "compact":
                    for f in findings:
                        print(f.compact(rel))
                else:  # json
                    bundle.extend(f.to_dict(file=rel) for f in findings)

    # EVERY `.amd` THE STORY NAMES HAS TO BE THERE.
    if not only_shared:
        named_from = mast_files or sorted(
            glob.glob(os.path.join(mission, "**", "*.mast"), recursive=True))
        for rel, number, message in _missing_amd_files(mission, named_from):
            total_err += 1
            if fmt == "text":
                print(f"== {rel} ==\n  [ERROR] line {number}: {message} (amd-file-missing)")
            elif fmt == "compact":
                print(f"{rel}:{number}:1: error: {message} [amd-file-missing]")
            else:
                bundle.append({"file": rel, "line": number, "severity": "error",
                               "code": "amd-file-missing", "message": message})

    # THE STORY HAS TO COMPILE. Everything above reads files; none of it runs the
    # compiler, so a mission whose story.mast does not compile - one line pasted at the
    # wrong indent is enough - was reported clean and then ran nothing at all.
    if not no_compile and not only_shared \
            and os.path.isfile(os.path.join(mission, "story.mast")):
        errors = _compile_errors(folder, mission)
        if errors == NOT_CHECKED:
            # "Could not check" is a NOTE. It used to be an error against line 1 of a
            # clean mission, ending "NOTHING in this mission runs", on any machine that
            # had never run `sbs debug`.
            errors = []
            if fmt == "text":
                print("== story.mast (compile) ==\n  not checked: the library that "
                      "checks whether the story compiles is not on this machine. "
                      f"`sbs debug {folder}` fetches it")
        headed = None
        for rel, number, what in (errors or []):
            total_err += 1
            # Python's own tail on an error it raised while reading ONE line of the
            # story: `(detected at line 1) (<mast:14>, line 1)`. Its "line 1" is the
            # first line of that one statement, beside the real line number in front.
            what = re.sub(r"\s*\(detected at line \d+\)", "", what)
            what = re.sub(r"\s*\(<mast:\d+>, line \d+\)", "", what)
            message = (f"{what}. The story does not compile, so NOTHING in this "
                       f"mission runs until this is fixed")
            if fmt == "text":
                if headed != rel:
                    print(f"== {rel} (compile) ==")       # once per file, not per error
                    headed = rel
                print(f"  [ERROR] line {number}: {message} (mast-compile)")
            elif fmt == "compact":
                print(f"{rel}:{number}:1: error: {message} [mast-compile]")
            else:
                bundle.append({"file": rel, "line": number, "severity": "error",
                               "code": "mast-compile", "message": message})

    # Whole-mission namespace pass: MAST merges every addon's .py into ONE global
    # namespace and register_mission_functions overwrites silently, so a name defined
    # twice fails at RUNTIME in whichever addon lost - intermittently, since addon load
    # order is not deterministic. Needs every file at once.
    try:
        from sbs_utils.procedural.namespace_lint import namespace_lint_project
    except Exception:
        namespace_lint_project = None
    if namespace_lint_project is not None and not only_shared:
        addon_dirs = set()
        for ini in glob.glob(os.path.join(mission, "*", "__init__.mast")):
            addon_dirs.add(os.path.dirname(ini))
        py_sources = []
        for d in sorted(addon_dirs):
            for path in sorted(glob.glob(os.path.join(d, "**", "*.py"), recursive=True)):
                if os.path.basename(path).startswith("test_"):
                    continue
                try:
                    with open(path, "r", encoding="utf-8", errors="replace") as fh:
                        py_sources.append((os.path.relpath(path, mission), fh.read()))
                except OSError:
                    continue
        ns_mast = []
        for path in sorted(glob.glob(os.path.join(mission, "**", "*.mast"), recursive=True)):
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    ns_mast.append((os.path.relpath(path, mission), fh.read()))
            except OSError:
                continue
        if py_sources:
            try:
                project = namespace_lint_project(py_sources, ns_mast, _library_mast_globals(),
                                                 mast_globals=_mast_global_names())
            except TypeError:
                # An older sbs_utils whose namespace_lint predates `mast_globals`.
                project = namespace_lint_project(py_sources, ns_mast, _library_mast_globals())
            by_file = {}
            for rel, f in project:
                by_file.setdefault(rel, []).append(f)
                if f.is_error():
                    total_err += 1
                else:
                    total_warn += 1
            for rel, findings in by_file.items():
                if fmt == "text":
                    print(f"== {rel} ==")
                    for f in findings:
                        print(f"  {f}")
                elif fmt == "compact":
                    for f in findings:
                        print(f.compact(rel))
                else:  # json
                    bundle.extend(f.to_dict(file=rel) for f in findings)

    # Tile world pass: area files, tileset files, and where the .amd puts props and
    # people on them. Every one of these fails SILENTLY at runtime (an area skipped, a
    # prop never placed), which is the whole reason to lint them.
    if tilemap_lint_mission is not None and not only_shared:
        by_file = {}
        for rel, f in tilemap_lint_mission(mission):
            by_file.setdefault(rel, []).append(f)
            if f.is_error():
                total_err += 1
            else:
                total_warn += 1
        for rel, findings in by_file.items():
            if fmt == "text":
                print(f"== {rel} (tiles) ==")
                for f in findings:
                    print(f"  {f}")
            elif fmt == "compact":
                for f in findings:
                    print(f.compact(rel))
            else:  # json
                bundle.extend(f.to_dict(file=rel) for f in findings)

    if fmt == "json":
        import json
        print(json.dumps(bundle, indent=2))
    elif fmt == "text":
        print(f"\n{len(amd_files)} amd + {len(mast_files)} mast file(s): "
              f"{total_err} error(s), {total_warn} warning(s)")
        if strict and total_warn and not total_err:
            # The same bytes as plain lint, and exit code 1: nobody could SEE that it
            # had failed.
            print("FAILED: --strict counts a warning as a failure")

    if total_err or (strict and total_warn):
        raise SystemExit(1)
