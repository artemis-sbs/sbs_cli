import click
import os
import sys
import glob
import json
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
    lib_dir = os.path.join(missions, "__lib__")
    libs = sorted(glob.glob(os.path.join(lib_dir, "*sbs_utils*.sbslib")), reverse=True)
    if libs:
        sys.path.append(libs[0])


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
    """Import the mission's own AMD field registrations, so its vocabulary is DECLARED
    before anything is linted.

    A mission adds its labels with `amd_register_fields`, which is exactly what stops
    `Disposition:` or `Flies:` failing silently - but the registration runs when the
    mission's Python is imported, and the linter never imported any. So Open Universe
    declared ~30 fields correctly and the linter still called every one of them unknown:
    169 warnings on OU, 46 once its module is loaded. 123 false ones, all telling an
    author their correct file is wrong.

    Convention over configuration: modules named `*_amd.py` are the ones that declare
    vocabulary (`universe_amd.py`). Narrow on purpose - importing a mission's whole
    Python would run spawn code and drag in the engine.

    Never fatal. A mission whose module cannot import offline still lints, just without
    its own words - which is exactly today's behaviour, so this can only improve on it.
    """
    root = os.path.abspath(mission)
    import importlib
    loaded = []

    def _try(name, *dirs):
        added = [d for d in dirs if d and d not in sys.path]
        sys.path[:0] = added
        try:
            importlib.import_module(name)
            loaded.append(name)
        except Exception:
            pass          # a module that needs the engine simply does not contribute

    for path in sorted(glob.glob(os.path.join(root, "**", "*_amd.py"), recursive=True)):
        _try(os.path.splitext(os.path.basename(path))[0], os.path.dirname(path), root)

    # ...and the mission's ADDONS. A mission authors the vocabulary of what it builds ON:
    # Storm's Beacon writes `Terrain:` and `Skybox:` because it uses the Open Universe
    # engine, and universe_amd.py declares both - but that file lives in the addon, so a
    # mission-only scan called seventeen correct lines unknown. Works for a packaged
    # mastlib too: a zip on sys.path is importable.
    for addon in _declared_addon_paths(root):
        if os.path.isdir(addon):
            for path in sorted(glob.glob(os.path.join(addon, "**", "*_amd.py"),
                                         recursive=True)):
                _try(os.path.splitext(os.path.basename(path))[0],
                     os.path.dirname(path), addon)
            continue
        try:
            with zipfile.ZipFile(addon) as z:
                names = [n for n in z.namelist() if n.endswith("_amd.py")]
        except Exception:
            continue
        for n in names:
            _try(os.path.splitext(os.path.basename(n))[0],
                 os.path.join(addon, os.path.dirname(n)) if os.path.dirname(n) else addon,
                 addon)
    return loaded


def _declared_addon_paths(mission_root):
    """Each mastlib `story.json` declares, as a source FOLDER (a clone editing its own
    addons) or the `__lib__` zip. Mirrors how the compiler resolves them."""
    out = []
    try:
        story = os.path.join(mission_root, "story.json")
        if not os.path.isfile(story):
            return out
        with open(story) as f:
            data = json.load(f) or {}
        lib_dir = os.path.join(os.path.dirname(mission_root), "__lib__")
        for name in (data.get("mastlib") or []):
            parts = str(name).split(".", 3)
            folder = os.path.join(mission_root, parts[2]) if len(parts) >= 4 else None
            if folder and os.path.isfile(os.path.join(folder, "__init__.mast")):
                out.append(folder)
                continue
            zip_path = os.path.join(lib_dir, name)
            if os.path.isfile(zip_path):
                out.append(zip_path)
    except Exception:
        pass
    return out


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


def _read_all(mission, pattern):
    """Read every file matching `pattern` under `mission` into a list of strings."""
    out = []
    for path in glob.glob(os.path.join(mission, "**", pattern), recursive=True):
        try:
            with open(path, "r") as f:
                out.append(f.read())
        except Exception:
            pass
    return out


def _mission_amd_keys(amd_files):
    """Union of every node key across all of a mission's .amd files - the symbol
    table cross-file references resolve against."""
    from sbs_utils.procedural.amd_core import parse
    keys = set()
    for path in amd_files:
        try:
            with open(path, "r") as f:
                keys |= parse(f.read()).keys
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
def lint(folder, strict, no_cross, no_signals, fmt, lsp):
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

    mission = os.path.join(missions, folder)
    if not os.path.isdir(mission):
        mission = folder  # allow an absolute or cwd-relative path
    if not os.path.isdir(mission):
        print(f"ERROR: not a folder: {folder}")
        raise SystemExit(2)

    try:
        amd_lint = _load_amd_lint(missions, mission)
        signal_lint = None if no_signals else _load_signal_lint(missions, mission)
    except Exception as e:
        print(f"ERROR: could not load sbs_utils to lint ({e})")
        raise SystemExit(2)

    amd_files = sorted(glob.glob(os.path.join(mission, "**", "*.amd"), recursive=True))
    mast_files = [] if no_signals else sorted(
        glob.glob(os.path.join(mission, "**", "*.mast"), recursive=True))
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

    total_err = total_warn = 0
    bundle = []

    # Packaging drift: a repo shipping its own addons must keep __lib__.json, story.json
    # and .gitattributes in step, or a FETCHED copy is quietly wrong.
    packaging = lint_self_packaging(mission)
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
        rel = os.path.relpath(path, mission)
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

    if fmt == "json":
        import json
        print(json.dumps(bundle, indent=2))
    elif fmt == "text":
        print(f"\n{len(amd_files)} amd + {len(mast_files)} mast file(s): "
              f"{total_err} error(s), {total_warn} warning(s)")

    if total_err or (strict and total_warn):
        raise SystemExit(1)
