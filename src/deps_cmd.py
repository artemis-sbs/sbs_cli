"""`sbs deps` - optional Python libraries, on an interpreter that cannot pip.

`sbs` runs on the embedded CPython in `PyRuntime`, and `PyRuntime/python311._pth`
has `import site` commented out. So `site-packages` is never on `sys.path`,
`PYTHONPATH` is ignored, and `python -m pip` answers *"No module named pip"* -
while pip itself sits in `PyRuntime/Lib/site-packages/pip`, present and
invisible. That is why plain `pip install` has never worked here, and why it
never will without help.

The help is small: put `site-packages` on the path of a CHILD process of the same
interpreter, and pip runs normally. Because it is the same interpreter, pip
resolves wheels against the real 3.11 ABI - no `--python-version` guessing, no
host/embedded mismatch, and C extensions work.

**Two targets, and they reach different places.**

    default     <missions>/__pylib__     read by `sbs` (cli_cmd) - host tooling
    --engine    <cosmos>/PyAddons        read by the ENGINE at startup

`PyAddons` is not new: it is where `ryaml.pyd` lives, and the reason `ryaml` is
importable inside a running mission. `--engine` is explicit and never the
default, because a mission that imports something from there is no longer
self-contained - it runs only where someone ran the same command.

**What this cannot do.** It cannot deliver native libraries that are not Python
packages. `pip install weasyprint` succeeds and then fails at import with
`cannot load library 'libgobject-2.0-0'`, because it needs GTK/Pango DLLs pip has
no way to supply on Windows. That is the trap this file exists to keep people out
of, so `install` says so before it runs.
"""
import os
import shutil
import subprocess
import sys

import click

from cli_cmd import cli, sidecar_dir, zipapp_dir

# Runs in a child of THIS interpreter. Env carries the path because PYTHONPATH is
# ignored here - the same reason `web_cmd._BOOT` exists and works the same way.
_PIP_BOOT = (
    "import sys,os;"
    "sys.path.insert(0, os.environ['SBS_PIP_SITE']);"
    "from pip._internal.cli.main import main;"
    "sys.exit(main(sys.argv[1:]))"
)

# Packages that install cleanly and then cannot be imported, because the wheel is
# a binding to native libraries pip does not carry on Windows. Warned about by
# name rather than discovered the hard way.
_NEEDS_NATIVE = {
    "weasyprint": "needs GTK/Pango; install the WeasyPrint Windows package instead",
    "cairocffi": "needs cairo",
    "pygobject": "needs GObject/GTK",
    "pycairo": "needs cairo",
}


def engine_dir():
    """`<cosmos>/PyAddons` - the folder the ENGINE puts on `sys.path` at startup.

    Found by walking up for the Cosmos root rather than counting `..` levels the
    way `compile_cmd` does. That count is only right when `zipapp_dir` is the
    missions folder, which is true of a deployed `sbs.pyz` and false when running
    from source - where it is `sbs_cli/`, one level deeper, and the arithmetic
    lands on `data/PyAddons`. The root is the directory holding `PyRuntime`."""
    here = os.path.abspath(str(zipapp_dir))
    for _ in range(6):
        if os.path.isdir(os.path.join(here, "PyRuntime")):
            return os.path.join(here, "PyAddons")
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    return os.path.normpath(os.path.join(str(zipapp_dir), "..", "..", "PyAddons"))


def site_packages():
    """Where pip lives, or None.

    Checked with `isdir`, never by importing: a failed import walks the whole of
    `sys.path`, which is the cost `fs.ryaml_module()` documents paying once and
    then caching."""
    candidates = []
    try:
        import pip                                    # a normal host Python
        candidates.append(os.path.dirname(os.path.dirname(pip.__file__)))
    except Exception:
        pass
    candidates.append(os.path.join(sys.base_prefix, "Lib", "site-packages"))
    try:
        import sysconfig
        candidates.append(sysconfig.get_paths()["purelib"])
    except Exception:
        pass
    candidates.append(os.path.join(os.path.dirname(sys.executable), "Lib",
                                   "site-packages"))
    for c in candidates:
        if c and os.path.isdir(os.path.join(c, "pip")):
            return c
    return None


def _target(engine):
    return engine_dir() if engine else sidecar_dir()


def _installed(target):
    """`[(name, version)]` from the `.dist-info` folders pip leaves behind."""
    out = []
    if not os.path.isdir(target):
        return out
    for entry in sorted(os.listdir(target)):
        if entry.endswith(".dist-info"):
            stem = entry[:-len(".dist-info")]
            name, _, version = stem.rpartition("-")
            out.append((name or stem, version))
    return out


@cli.group()
def deps():
    """Optional Python libraries for `sbs` (and, with --engine, for missions).

    \b
    sbs deps install pypdf     PDF bookmarks and merged books for `sbs docs`
    sbs deps list              what is installed, and where
    sbs deps path              print the folder (for scripting)

    These are OPTIONAL. Every feature that uses one degrades to working without
    it; nothing here is needed to run `sbs`.
    """


@deps.command("path")
@click.option("--engine", is_flag=True, help="Show the PyAddons folder instead.")
def deps_path(engine):
    """Print the folder libraries are installed into."""
    print(_target(engine))


@deps.command("list")
def deps_list():
    """What is installed, in both folders."""
    for label, target, note in (
            ("sbs (host tooling)", sidecar_dir(), "read by sbs commands"),
            ("engine (PyAddons)", engine_dir(), "read by a running mission")):
        rows = _installed(target)
        print(f"{label}  {target}")
        print(f"  {note}")
        if not rows:
            print("  (empty)")
        else:
            for name, version in rows:
                print(f"  {name} {version}")
        print()
    print("pip --target does no cross-install resolution: two installs can leave")
    print("incompatible versions side by side without an error.")


@deps.command("install")
@click.argument("packages", nargs=-1, required=True)
@click.option("--engine", is_flag=True,
              help="Install into PyAddons so a RUNNING MISSION can import it. "
                   "That mission is then no longer self-contained.")
@click.option("--yes", is_flag=True, help="Skip the --engine confirmation.")
def deps_install(packages, engine, yes):
    """Install PACKAGES with pip, into the sidecar."""
    for pkg in packages:
        hint = _NEEDS_NATIVE.get(pkg.split("[")[0].split("=")[0].strip().lower())
        if hint:
            print(f"ERROR: {pkg} cannot be installed this way - {hint}")
            print("       pip will appear to succeed and the import will fail.")
            raise SystemExit(2)

    site = site_packages()
    if site is None:
        print(f"ERROR: pip is not reachable from this Python ({sys.executable})")
        print("       the embedded runtime ships pip under Lib/site-packages;")
        print("       if it is gone, reinstall Cosmos")
        raise SystemExit(2)

    target = _target(engine)
    if engine and not yes:
        print(f"This installs into the Cosmos install at {target},")
        print("where a RUNNING MISSION can import it. A mission that does is no")
        print("longer self-contained - it will only run where this was also run.")
        if not click.confirm("Continue?", default=False):
            raise SystemExit(1)

    os.makedirs(target, exist_ok=True)
    env = dict(os.environ, SBS_PIP_SITE=site)
    argv = [sys.executable, "-c", _PIP_BOOT, "install", "--target", target,
            "--upgrade", *packages]
    print(f"installing into {target}")
    try:
        rc = subprocess.call(argv, env=env)
    except OSError as e:
        print(f"ERROR: could not run pip ({e})")
        raise SystemExit(2)
    if rc != 0:
        print(f"ERROR: pip exited {rc}")
        raise SystemExit(1)
    if not engine:
        print("done - `sbs` will pick these up on its next run")
    else:
        print("done - a mission can import these; `sbs` cannot, unless also "
              "installed without --engine")


@deps.command("remove")
@click.argument("package")
@click.option("--engine", is_flag=True, help="Remove from PyAddons instead.")
def deps_remove(package, engine):
    """Delete PACKAGE from the sidecar.

    `pip uninstall` does not understand `--target`, so this removes the folders
    pip wrote. Only what the package's own `RECORD` claims, so a shared
    dependency of something else is not taken with it."""
    target = _target(engine)
    rows = [r for r in _installed(target) if r[0].lower() == package.lower()]
    if not rows:
        print(f"{package} is not installed in {target}")
        raise SystemExit(1)
    name, version = rows[0]
    info = os.path.join(target, f"{name}-{version}.dist-info")
    tops = set()
    record = os.path.join(info, "RECORD")
    if os.path.isfile(record):
        with open(record, encoding="utf-8", errors="replace") as f:
            for line in f:
                first = line.split(",", 1)[0].replace("\\", "/").split("/")[0]
                if first and not first.startswith(".."):
                    tops.add(first)
    tops.add(os.path.basename(info))
    for top in sorted(tops):
        path = os.path.join(target, top)
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass
    print(f"removed {name} {version} from {target}")
