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


def _load_amd_lint(missions, mission):
    """Import `amd_lint` - working tree first, else the mission's own sbslib."""
    _prefer_working_tree_sbs_utils(missions, mission)
    sys.path.insert(0, mission)
    try:
        from sbs_utils.procedural.amd_lint import amd_lint
        return amd_lint
    except Exception:
        # Fall back to the libraries the mission itself declares.
        sbs_lib_import(missions, mission)
        from sbs_utils.procedural.amd_lint import amd_lint
        return amd_lint


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
@click.option("--format", "fmt", type=click.Choice(["text", "compact", "json"]),
              default="text", help="Output format: text (human), compact "
              "(file:line:col: for editor problem-matchers), or json (tools/CI).")
@click.option("--lsp", is_flag=True,
              help="Run as an AMD language server (LSP over stdio) for editors.")
def lint(folder, strict, no_cross, fmt, lsp):
    """Lint the .amd files in a mission FOLDER.

    Structural problems (broken headings, unclosed `---` fences, heading-level
    jumps) are ERRORs and fail the run. Dangling references (choice/Scene/reveal
    targets, emitted signals with no route, reach cells with no landmark) are
    WARNINGs. Exit code: 1 if any error (or any finding under --strict), else 0.

    With --lsp, run an editor language server on stdin/stdout instead (VSCode,
    Neovim, Emacs, ...): live diagnostics as you type.
    """
    missions = zipapp_dir

    if lsp:
        # The server lives in sbs_utils; make sure the (working-tree) copy is
        # importable, then hand stdio over to it.
        _prefer_working_tree_sbs_utils(missions, missions)
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
    except Exception as e:
        print(f"ERROR: could not load sbs_utils to lint ({e})")
        raise SystemExit(2)

    amd_files = sorted(glob.glob(os.path.join(mission, "**", "*.amd"), recursive=True))
    if not amd_files:
        if fmt == "json":
            print("[]")
        else:
            print(f"No .amd files under {mission}")
        return

    mast_sources = None
    if not no_cross:
        mast_sources = _read_all(mission, "*.mast") + _read_all(mission, "*.py")
        mastlib_sig = _mastlib_signal_source(missions, mission)
        if mastlib_sig:
            mast_sources.append(mastlib_sig)

    total_err = total_warn = 0
    bundle = []
    for path in amd_files:
        findings = amd_lint(file_path=path, mast_sources=mast_sources,
                            cross_file=not no_cross)
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

    if fmt == "json":
        import json
        print(json.dumps(bundle, indent=2))
    elif fmt == "text":
        print(f"\n{len(amd_files)} file(s): {total_err} error(s), {total_warn} warning(s)")

    if total_err or (strict and total_warn):
        raise SystemExit(1)
