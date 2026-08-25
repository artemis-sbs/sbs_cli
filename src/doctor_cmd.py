"""`sbs doctor` - is this machine and this mission set up correctly?

**Scope, and it is a hard line:** doctor answers *"is this set up correctly"*.
It never answers *"is this content correct"*. It may read `story.json`,
`__lib__.json`, directory listings and file times. It must not parse a `.amd` or
compile a `.mast` - those questions belong to `sbs lint` and `sbs compile`, and
doctor points at them rather than growing a second opinion.

That line is not a style preference. A report that also checks content becomes a
slower linter that disagrees with the linter, and then nobody trusts either.
`tests/test_doctor_cmd.py` enforces it by failing if doctor opens one of those
files.

Doctor exits 0. A report that fails the build IS a linter; `--strict` is there
for anyone who wants the other behavior.
"""
import json
import os
import subprocess
import sys

import click

from cli_cmd import cli, zipapp_dir

OK, ABSENT, PROBLEM = "ok", "--", "!!"


class Report:
    """Collects `(section, name, status, detail, remedy)` and prints them."""

    def __init__(self):
        self.rows = []

    def add(self, section, name, status, detail="", remedy=""):
        self.rows.append({"section": section, "name": name, "status": status,
                          "detail": detail, "remedy": remedy})

    @property
    def problems(self):
        return [r for r in self.rows if r["status"] == PROBLEM]

    @property
    def tally(self):
        """How many checks ran, and how they landed."""
        return {
            "checks": len(self.rows),
            "ok": sum(1 for r in self.rows if r["status"] == OK),
            "absent": sum(1 for r in self.rows if r["status"] == ABSENT),
            "problems": len(self.problems),
        }

    def echo(self):
        section = None
        for r in self.rows:
            if r["section"] != section:
                section = r["section"]
                print(section)
            print(f"  {r['status']}  {r['name']:<11} {r['detail']}".rstrip())
            if r["remedy"]:
                print(f"      {r['remedy']}")
        self.echo_summary()

    def echo_summary(self):
        """One line of arithmetic, and where to look if it is not all `ok`.

        A full report is long enough that a single flagged row scrolls past unnoticed - the
        half-baked-art check exists because exactly that had been happening to a failing
        unit test for weeks. The tally makes "is anything wrong" answerable without reading
        every line, and naming the SECTIONS is the part that saves time: the remedies are
        printed inline beside each row already, so repeating them here would be noise.

        `--` is counted APART from problems on purpose. It means an optional thing is not
        installed, which is not a fault, and folding it into one "not ok" number would make
        a healthy machine look broken.
        """
        t = self.tally
        bits = f"{t['checks']} checks: {t['ok']} ok"
        if t["absent"]:
            bits += f", {t['absent']} optional absent"
        bits += f", {t['problems']} problem" + ("" if t["problems"] == 1 else "s")
        print()
        print(bits)
        if t["problems"]:
            where = []
            for r in self.problems:
                if r["section"] not in where:
                    where.append(r["section"])
            print("to fix: " + ", ".join(where) + " (remedies are beside each row above)")

    def as_json(self):
        from version import VERSION
        return json.dumps({"sbs": VERSION, "summary": self.tally,
                           "checks": self.rows}, indent=2)


def _missions_dir():
    """The missions folder, in dev and deployed modes alike.

    `zipapp_dir` is the missions folder only when deployed; from source it is
    `sbs_cli/`, one level deeper, and a doctor that reported THAT would call
    every mission's libraries missing. `debug_cmd` already solved this."""
    try:
        from debug_cmd import _missions_dir as resolved
        return resolved()
    except Exception:
        return str(zipapp_dir)


# --- environment -------------------------------------------------------------

def _check_sbs(rep):
    from version import VERSION
    packaged = ".pyz" in os.path.abspath(__file__)
    rep.add("sbs", "version", OK, VERSION)
    rep.add("sbs", "running", OK,
            "from sbs.pyz" if packaged else f"from source ({os.path.dirname(__file__)})")
    rep.add("sbs", "missions", OK, _missions_dir())


def _check_python(rep):
    exe = sys.executable
    embedded = os.path.isfile(os.path.join(os.path.dirname(exe), "python311._pth"))
    rep.add("Python", "version", OK,
            f"{sys.version.split()[0]} {'embedded' if embedded else 'host'} ({exe})")
    if embedded:
        # The single most useful line in this report. It is the reason
        # `pip install` has never worked here and the reason `sbs deps` exists.
        rep.add("Python", "paths", OK,
                "PYTHONPATH is ignored and site-packages is not on sys.path",
                "use `sbs deps install X` for optional libraries")


def _check_layout(rep):
    missions = _missions_dir()
    lib = os.path.join(missions, "__lib__")
    if os.path.isdir(lib):
        n = len([f for f in os.listdir(lib) if f.endswith((".sbslib", ".mastlib"))])
        rep.add("Layout", "__lib__", OK, f"{n} libraries")
    else:
        rep.add("Layout", "__lib__", ABSENT, "no __lib__ beside the missions",
                "run: sbs fetch")

    try:
        from lint_cmd import _ensure_sbs_utils_importable
        _ensure_sbs_utils_importable(missions)
        import sbs_utils
        # A NAMESPACE package has `__file__ = None` - which is what you get when
        # the REPO folder (`missions/sbs_utils/`, no `__init__.py`) is on the
        # path instead of the package inside it. That is a real misconfiguration
        # and worth naming, not crashing on.
        origin = getattr(sbs_utils, "__file__", None)
        if origin is None:
            paths = list(getattr(sbs_utils, "__path__", []) or [])
            rep.add("Layout", "sbs_utils", PROBLEM,
                    "imported as a namespace package with no module: "
                    + (paths[0] if paths else "unknown"),
                    "the sbs_utils PACKAGE is one level inside the repo folder")
            return
        where = os.path.dirname(os.path.dirname(os.path.abspath(origin)))
        kind = "sbslib" if ".sbslib" in where else "working tree"
        rep.add("Layout", "sbs_utils", OK, f"{kind}: {where}")
    except Exception as e:
        rep.add("Layout", "sbs_utils", PROBLEM, f"not importable ({e})",
                "run: sbs fetch, or check __lib__")
        return

    try:
        from sbs_utils.procedural.amd_assets import face_js_path, graphics_dir
        gfx = graphics_dir(missions)
        if gfx:
            rep.add("Layout", "graphics", OK, gfx)
        else:
            rep.add("Layout", "graphics", ABSENT,
                    "no Cosmos data/graphics found",
                    "image:// engine art and face atlases will not resolve")
        if face_js_path():
            rep.add("Layout", "faces", OK, "compositor available")
        else:
            rep.add("Layout", "faces", ABSENT,
                    "cosmos_dev is not installed",
                    "faces will print as placeholders in `sbs docs`")
    except Exception as e:
        rep.add("Layout", "graphics", ABSENT, f"could not check ({e})")

    py_addons = _py_addons()
    if os.path.isdir(py_addons):
        ry = "with ryaml" if os.path.isfile(os.path.join(py_addons, "ryaml.pyd")) \
            else "no ryaml.pyd"
        rep.add("Layout", "PyAddons", OK, f"{py_addons} ({ry})")
    else:
        rep.add("Layout", "PyAddons", ABSENT, "not found")


def _py_addons():
    try:
        from deps_cmd import engine_dir
        return engine_dir()
    except Exception:
        return os.path.join(_missions_dir(), "..", "..", "PyAddons")


def _tool(rep, name, argv, remedy):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=20)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        rep.add("Tools", name, ABSENT, "not found", remedy)
        return
    line = (r.stdout or r.stderr or "").strip().splitlines()
    rep.add("Tools", name, OK, line[0] if line else "present")


def _check_tools(rep):
    _tool(rep, "git", ["git", "--version"], "needed by `sbs fetch --source`")
    _tool(rep, "curl", ["curl", "--version"], "needed by `sbs fetch` and `sbs update`")
    try:
        import pdf_out
        eng = pdf_out.find_browser()
        if eng:
            rep.add("Tools", "browser", OK, f"{eng.kind} {eng.version} ({eng.exe})")
        else:
            rep.add("Tools", "browser", ABSENT, "no Chromium browser found",
                    "install Microsoft Edge or Chrome for `sbs docs --pdf`")
        weasy = pdf_out.find_weasyprint()
        if weasy:
            rep.add("Tools", "weasyprint", OK, weasy)
        else:
            rep.add("Tools", "weasyprint", ABSENT,
                    "not installed - PDFs will have no contents page numbers",
                    "install the WeasyPrint package; pip alone cannot supply "
                    "its GTK libraries")
    except Exception as e:
        rep.add("Tools", "browser", ABSENT, f"could not check ({e})")


def _check_sidecar(rep):
    try:
        from cli_cmd import sidecar_dir
        from deps_cmd import _installed, engine_dir, site_packages
    except Exception as e:
        rep.add("Sidecar", "deps", ABSENT, f"unavailable ({e})")
        return
    for label, path in (("sbs", sidecar_dir()), ("engine", engine_dir())):
        rows = _installed(path)
        if rows:
            rep.add("Sidecar", label, OK,
                    ", ".join(f"{n} {v}" for n, v in rows))
        else:
            rep.add("Sidecar", label, ABSENT, f"empty ({path})")
    if site_packages() is None:
        rep.add("Sidecar", "pip", PROBLEM, "pip is not reachable",
                "`sbs deps install` will not work")


# --- mission health ----------------------------------------------------------

def _check_mission(rep, mission):
    name = os.path.basename(os.path.abspath(mission))
    story = os.path.join(mission, "story.json")
    if not os.path.isfile(story):
        rep.add(name, "story.json", ABSENT, "not a mission folder")
        return
    try:
        with open(story, encoding="utf-8") as f:
            data = json.load(f) or {}
    except Exception as e:
        rep.add(name, "story.json", PROBLEM, f"will not parse ({e})",
                "the mission cannot load until this is valid JSON")
        return

    sbslib = list(data.get("sbslib", []))
    mastlib = list(data.get("mastlib", []))
    media = list((data.get("resources") or {}).values())
    rep.add(name, "story.json", OK,
            f"{len(sbslib)} sbslib, {len(mastlib)} mastlib, {len(media)} media")

    lib = os.path.join(_missions_dir(), "__lib__")
    missing = [a for a in sbslib + mastlib + media
               if isinstance(a, str) and not os.path.isfile(os.path.join(lib, a))]
    if missing:
        rep.add(name, "libraries", PROBLEM,
                f"{len(missing)} declared but not in __lib__: "
                + ", ".join(missing[:3]) + ("..." if len(missing) > 3 else ""),
                "run: sbs fetch  (or `sbs lib <folder>` if you build them here)")
    else:
        rep.add(name, "libraries", OK, "all declared libraries present")

    _check_freshness(rep, name, mission, mastlib, lib)
    _check_packaging(rep, name, mission)

    _check_shipdata(rep, name, mission)
    _check_derived_art(rep, name, mission, "mission art")


def _check_shipdata(rep, name, mission):
    """`extraShipData.json` is a problem only when it is GENERATED.

    The hazard is real - the library reads the file back while the add-on merges
    the same entries again, and 51 hulls become 102 from run 2 onward. But the
    same filename is also a legitimate authored fixture: `LM_TestRange` commits
    one because its engine probe exists to test whether the engine re-reads that
    very file, and `VisualTestRange` commits one to reproduce an art bug.
    Flagging those told people to delete the instrument.

    Tracked in git is the tell: authored content gets committed, generated output
    gets ignored. Asking git is cheaper and more honest than guessing from the
    contents."""
    present = [f for f in ("extraShipData.json", "extraShipData.json.bak")
               if os.path.isfile(os.path.join(mission, f))]
    if not present:
        return
    tracked = set()
    try:
        r = subprocess.run(["git", "-C", mission, "ls-files"] + present,
                           capture_output=True, text=True, timeout=20)
        tracked = {os.path.basename(x.strip()) for x in r.stdout.splitlines() if x.strip()}
        if r.returncode != 0:
            raise OSError("not a repo")
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        # Not a repo, or no git. Fall back to the other tell: a `.bak` beside the
        # file means something WROTE it, and nobody hand-authors a `.bak`. With
        # neither signal, say nothing rather than guess wrong.
        if any(f.endswith(".bak") for f in present):
            rep.add(name, "shipdata", PROBLEM,
                    ", ".join(present) + " present (a .bak means it was written)",
                    "delete it; the library reads it back while the add-on merges "
                    "the same hulls again")
        return
    generated = [f for f in present if f not in tracked]
    if generated:
        rep.add(name, "shipdata", PROBLEM,
                ", ".join(generated) + " present and untracked (generated output)",
                "delete it; the library reads it back while the add-on merges "
                "the same hulls again")
    if tracked:
        rep.add(name, "shipdata", OK,
                ", ".join(sorted(tracked)) + " (committed - authored, left alone)")


def _check_freshness(rep, name, mission, mastlib, lib):
    """A built `.mastlib` older than its source is the classic "my change did
    nothing" - the engine reads the lib, the runner reads the source."""
    stale = []
    for asset in mastlib:
        if not isinstance(asset, str):
            continue
        zip_path = os.path.join(lib, asset)
        if not os.path.isfile(zip_path):
            continue
        addon = asset.split(".")[-3] if asset.count(".") >= 3 else None
        src = os.path.join(mission, addon) if addon else None
        if not src or not os.path.isdir(src):
            continue
        newest = 0
        for root, _dirs, files in os.walk(src):
            for f in files:
                try:
                    newest = max(newest, os.path.getmtime(os.path.join(root, f)))
                except OSError:
                    pass
        if newest > os.path.getmtime(zip_path):
            stale.append(addon)
    if stale:
        rep.add(name, "freshness", PROBLEM,
                "source newer than the built lib: " + ", ".join(sorted(set(stale))),
                f"run: sbs lib {os.path.basename(os.path.abspath(mission))}")


def _check_packaging(rep, name, mission):
    try:
        from lint_cmd import lint_self_packaging
        findings = lint_self_packaging(mission) or []
    except Exception:
        return
    for item in findings:
        try:
            severity, message = item[0], item[1]
        except Exception:
            severity, message = "warning", str(item)
        rep.add(name, "packaging",
                PROBLEM if str(severity).lower().startswith("err") else ABSENT,
                message)


def _art_dirs(base):
    """Folders under `base` that hold source meshes. Cheap walk, no content read."""
    out = []
    for root, subdirs, files in os.walk(base):
        if "__pycache__" in root:
            continue
        if any(f.lower().endswith(".obj") for f in files):
            out.append(root)
    return out


def _check_derived_art(rep, section, base, label):
    """Half-baked art: a `.paxmesh` whose sprites were never written.

    THE FAILURE THIS CATCHES IS A CRASH, not a cosmetic gap. The engine bakes a hull's
    derived art on first draw. If it dies partway it leaves the mesh without its sprites,
    and every later draw retries, dies at the same point, and leaves the same wreckage - so
    one bad hull crashes that client forever. Three hulls in one install cost two separate
    crash investigations before anyone thought to look at the folder.

    Directory listings only, which is what keeps this inside doctor's scope: it never opens
    the art, it counts names beside each other.
    """
    from file_help import derived_art_status
    half, unbaked, complete = [], 0, 0
    for folder in _art_dirs(base):
        for root, info in derived_art_status(folder).items():
            if info["state"] == "half":
                half.append((os.path.relpath(folder, base), root, info["absent"]))
            elif info["state"] == "unbaked":
                unbaked += 1
            else:
                complete += 1
    if half:
        shown = ", ".join(f"{r} (no {'/'.join(a)})" for _, r, a in half[:4])
        more = f" +{len(half) - 4} more" if len(half) > 4 else ""
        rep.add(section, "art", PROBLEM,
                f"{len(half)} half-baked in {label}: {shown}{more}",
                "delete the derived files and let the engine bake clean - "
                "`sbs art clear` (a mesh without its sprites crashes the client on every draw)")
    else:
        rep.add(section, "art", OK,
                f"{complete} baked, {unbaked} not yet drawn, 0 half-baked in {label}")


def _check_stray_sprites(rep, cosmos_root):
    """`<root>256.png` written to the EXE ROOT instead of beside the art.

    A documented engine bug (VisualTestRange/ENGINE_BUG_derived_art_generation.md): the 256
    bitmap lands in the working directory. Two consequences - the art folder never becomes
    complete on its own, so every load regenerates and drops another copy; and it made the
    file look ungeneratable while investigating, because looking beside the art showed
    nothing. Not seen on 1.3.6, so this may already be fixed; it costs one listing to notice
    if it comes back.
    """
    try:
        stray = sorted(f for f in os.listdir(cosmos_root)
                       if f.lower().endswith(("256.png", "1024.png")))
    except OSError:
        return
    if stray:
        rep.add("install", "stray art", PROBLEM,
                f"{len(stray)} sprite(s) at the exe root: " + ", ".join(stray[:4]),
                "the engine wrote these to the working directory instead of beside the "
                "art; move them next to their mesh, or the folder never completes")


@cli.command()
@click.argument("folder", default=None, required=False)
@click.option("--env", "env_only", is_flag=True, help="Environment only.")
@click.option("--json", "as_json", is_flag=True, help="Machine-readable output.")
@click.option("--strict", is_flag=True, help="Exit 1 if anything is flagged.")
def doctor(folder, env_only, as_json, strict):
    """Check this machine, and a mission FOLDER, are set up correctly.

    Reports what is installed and what a mission declares versus what is
    actually on disk. It does NOT check content - for that, run `sbs lint`
    (AMD) or `sbs compile` (MAST).

    Exits 0: this is a report, and a report that fails a build is a linter.
    Use --strict for the other behavior.
    """
    rep = Report()
    _check_sbs(rep)
    _check_python(rep)
    _check_layout(rep)
    _check_tools(rep)
    _check_sidecar(rep)
    _cosmos = os.path.dirname(os.path.dirname(_missions_dir()))
    _graphics = os.path.join(_cosmos, "data", "graphics")
    if os.path.isdir(_graphics):
        _check_derived_art(rep, "install", _graphics, "data/graphics")
        _check_stray_sprites(rep, _cosmos)

    if not env_only:
        missions = _missions_dir()
        targets = []
        if folder:
            cand = os.path.join(missions, folder)
            targets = [cand if os.path.isdir(cand) else folder]
        else:
            targets = [os.path.join(missions, d) for d in sorted(os.listdir(missions))
                       if os.path.isfile(os.path.join(missions, d, "story.json"))]
        for mission in targets:
            if os.path.isdir(mission):
                _check_mission(rep, mission)
            else:
                print(f"ERROR: not a folder: {folder}")
                raise SystemExit(2)

    if as_json:
        print(rep.as_json())
    else:
        rep.echo()
        if not env_only:
            print()
            print("content checks: sbs lint <folder> (AMD), sbs compile <folder> (MAST)")
    if strict and rep.problems:
        raise SystemExit(1)
