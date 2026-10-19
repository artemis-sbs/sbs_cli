"""`sbs art portraits` - render a sheet of ship PORTRAITS from the hulls' OBJ art.

`send_gui_3dship` is a live 3D render per widget, and a list with a ship on every row pays
for each one. A portrait is a cell of a sheet, drawn as an image or as a face - the cost of
a tile. sbs_utils draws them (`procedural/ship_portraits.py`); this builds them.

    sbs art portraits                     the BASE game -> sbs_utils/media/ship_portraits
    sbs art portraits Cosmos-TNG-Mod      a mod's own hulls -> <mod>/media/ship_portraits

UP TO DATE BY SIGNATURE, not by date. Each cell records a hash of its hull's OBJ, MTL and
textures plus the renderer and camera preset. A run renders only the cells whose hash
changed, new hulls, and nothing else - a second run with nothing changed launches no
browser and writes no file. `--check` reports the stale and missing without rendering.

SLOTS ARE STABLE. A hull keeps its cell across rebuilds; a new hull takes a free cell; a
removed hull frees its own. A face string handed out earlier (`shp_base0 #fff 3 1;`) has to
go on meaning the same ship.

THE RENDERER is the browser mock's own three.js loader (`cosmos_dev/mockgui/ship_render.js`)
in `portrait.html`, run in a headless Edge or Chrome. No Python image library is needed:
the page composes the sheet itself and posts the PNG back.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile

import click

from art_cmd import art
from engine_exe import cosmos_root

FORMAT = 1
RENDERER = "browser-three/1"
PRESET = "three-quarter/1"
DEFAULT_CELL = 256
DEFAULT_COLS = 16
MAX_ROWS = 16                 # 16 x 256 = 4096, the safe texture size on any GPU
EXTRAS = ("unknown",)         # cells every set carries, before any hull

# Sides that are not ships: crystals, pickups, the cursor. With no `hullpoints` either,
# they are skipped unless `--all`.
_ART_EXT = (".obj", ".mtl", "_diffuse.png", "_specular.png", "_emissive.png", "_normal.png")


# ---------------------------------------------------------------------------------------
# Hulls
# ---------------------------------------------------------------------------------------
def collect_hulls(paths, include_all=False):
    """[{key, art}] from ship-data files, read as TEXT (they are HJSON with comments).

    Only entries with `hullpoints` by default - ships and stations. Pickups, asteroids
    and the cursor have none and are not worth a portrait; `include_all` takes them too.
    First declaration of a key wins, as the engine's own merge does.
    """
    out, seen = [], set()
    pat = r'"key"\s*:\s*"([^"]+)"(.*?)(?="key"\s*:|\Z)'
    for path in paths:
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        for key, body in re.findall(pat, text, re.S):
            if key in seen:
                continue
            art = re.search(r'"artfileroot"\s*:\s*"([^"]*)"', body)
            if not art or not art.group(1):
                continue
            if not include_all and not re.search(r'"hullpoints"\s*:', body):
                continue
            seen.add(key)
            out.append({"key": key, "art": art.group(1).replace("\\", "/")})
    return out


def art_path(cosmos, art, fallback_media=None):
    """The art root on disk (no extension), or None.

    `ships/x` is relative to data/graphics; `data/missions/...` to the Cosmos root. A mod
    hull points into its UNPACKED pack under __lib__/media; when that is not unpacked,
    `fallback_media` (the mod's own media folder) is tried with the path inside the pack.
    """
    rel = art.lstrip("/")
    base = cosmos if rel.lower().startswith("data/") else os.path.join(cosmos, "data", "graphics")
    cand = os.path.join(base, *rel.split("/"))
    if os.path.isfile(cand + ".obj"):
        return cand
    if fallback_media:
        m = re.search(r"__lib__/media/[^/]+/(.+)$", rel)
        if m:
            alt = os.path.join(fallback_media, *m.group(1).split("/"))
            if os.path.isfile(alt + ".obj"):
                return alt
    return None


def signature(root, cell):
    """sha1 over the hull's art bytes, the renderer, the preset and the cell size."""
    h = hashlib.sha1()
    h.update(f"{RENDERER}|{PRESET}|{cell[0]}x{cell[1]}".encode())
    for ext in _ART_EXT:
        p = root + ext
        if os.path.isfile(p):
            h.update(ext.encode())
            with open(p, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
    return h.hexdigest()


def extra_signature(name, cell):
    return hashlib.sha1(f"{RENDERER}|{PRESET}|{cell[0]}x{cell[1]}|extra:{name}".encode()).hexdigest()


# ---------------------------------------------------------------------------------------
# Slots
# ---------------------------------------------------------------------------------------
def plan(manifest, wanted, cols, cell, force=False, max_rows=MAX_ROWS):
    """Assign cells and decide what to draw.

    Args:
        manifest: the existing manifest dict, or None.
        wanted: {key: sig} for every hull (and `#extra` names) that should have a cell.
        force: redraw every cell.

    Returns:
        (cells, todo, cleared): `cells` is {key: {page, col, row, sig}}; `todo` the keys
        to draw; `cleared` the {page, col, row} slots freed by removed hulls.

    A key already placed KEEPS its slot. New keys take the lowest free slot, page-major
    then row-major. A change of grid (cols or cell) invalidates every slot - the old
    positions no longer mean the same pixels - so everything is placed fresh.
    """
    old = dict((manifest or {}).get("cells") or {})
    for name, at in ((manifest or {}).get("extras") or {}).items():
        old["#" + name] = at
    same_grid = bool(manifest) and manifest.get("cols") == cols and \
        list(manifest.get("cell") or []) == list(cell)
    if not same_grid:
        old = {}
    per_page = cols * max_rows
    taken, cells, cleared = set(), {}, []
    for key, at in old.items():
        slot = (int(at.get("page", 0)), int(at["row"]), int(at["col"]))
        if key in wanted:
            cells[key] = {"page": slot[0], "col": slot[2], "row": slot[1],
                          "sig": at.get("sig")}
            taken.add(slot)
        else:
            cleared.append({"page": slot[0], "col": slot[2], "row": slot[1]})

    def _free():
        n = 0
        while True:
            page, rest = divmod(n, per_page)
            row, col = divmod(rest, cols)
            if (page, row, col) not in taken:
                return page, row, col
            n += 1

    # Extras first, so a fresh set has `unknown` at the first cell.
    for key in sorted(wanted, key=lambda k: (not k.startswith("#"), k)):
        if key in cells:
            continue
        page, row, col = _free()
        taken.add((page, row, col))
        cells[key] = {"page": page, "col": col, "row": row, "sig": None}
    todo = [k for k, at in cells.items() if force or at["sig"] != wanted[k]]
    for k in cells:
        cells[k]["sig"] = wanted[k]
    return cells, sorted(todo), cleared


def build_manifest(set_name, alias, cell, cols, cells, arts):
    pages = {}
    for at in cells.values():
        pages[at["page"]] = max(pages.get(at["page"], 0), at["row"] + 1)
    out = {"format": FORMAT, "set": set_name, "alias": alias, "cell": list(cell),
           "cols": cols, "renderer": RENDERER, "preset": PRESET,
           "pages": [{"file": f"{set_name}_{p}", "rows": pages[p]}
                     for p in range(max(pages) + 1 if pages else 0)],
           "cells": {}, "extras": {}}
    for key in sorted(cells):
        at = cells[key]
        entry = {"page": at["page"], "col": at["col"], "row": at["row"], "sig": at["sig"]}
        if key.startswith("#"):
            out["extras"][key[1:]] = entry
        else:
            entry["art"] = arts.get(key, "")
            out["cells"][key] = entry
    return out


# ---------------------------------------------------------------------------------------
# The renderer: a local server and a headless browser
# ---------------------------------------------------------------------------------------
def find_mockgui(missions):
    """{name: bytes-getter} for the renderer's page and scripts.

    The sbs_utils working tree when there is one (the page is developed there), else the
    newest cosmos_dev sbslib in __lib__ - the dev library `sbs fetch` brings beside it.
    """
    names = ("portrait.html", "ship_render.js", "three.min.js")
    tree = os.path.join(missions, "sbs_utils", "cosmos_dev", "mockgui")
    if all(os.path.isfile(os.path.join(tree, n)) for n in names):
        return {n: (lambda p=os.path.join(tree, n): open(p, "rb").read()) for n in names}
    lib = os.path.join(missions, "__lib__")
    try:
        libs = sorted(f for f in os.listdir(lib)
                      if ".cosmos_dev." in f and f.endswith(".sbslib") and "_dev" not in f)
    except OSError:
        libs = []
    for name in reversed(libs):
        path = os.path.join(lib, name)
        try:
            with zipfile.ZipFile(path) as z:
                have = set(z.namelist())
                if all(f"cosmos_dev/mockgui/{n}" in have for n in names):
                    return {n: (lambda p=path, n=n: zipfile.ZipFile(p).read(f"cosmos_dev/mockgui/{n}"))
                            for n in names}
        except (OSError, zipfile.BadZipFile):
            continue
    return None


def find_browser(explicit=None):
    if explicit:
        return explicit if os.path.isfile(explicit) else None
    pf = os.environ.get("PROGRAMFILES", r"C:\Program Files")
    pf86 = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
    local = os.environ.get("LOCALAPPDATA", "")
    for cand in (os.path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
                 os.path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
                 os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
                 os.path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
                 os.path.join(local, "Google", "Chrome", "Application", "chrome.exe")):
        if cand and os.path.isfile(cand):
            return cand
    for name in ("msedge", "google-chrome", "chromium", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    return None


def render(job, files, cosmos, out_dir, browser=None, show=False, timeout=None):
    """Serve `job` to portrait.html, run the browser, write the posted pages.

    Returns {"rendered": [...], "failed": [...]}. Pages are written beside the manifest
    through a temp file, so a dead browser never leaves half a sheet."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    result = {}
    done = threading.Event()
    cosmos_abs = os.path.abspath(cosmos)
    pages_by_index = {p["index"]: p for p in job["pages"]}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body=b"", ctype="text/plain"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?")[0]
            if path in ("/", "/portrait.html"):
                return self._send(200, files["portrait.html"](), "text/html")
            if path.lstrip("/") in files:
                return self._send(200, files[path.lstrip("/")](), "application/javascript")
            if path == "/job.json":
                return self._send(200, json.dumps(job).encode(), "application/json")
            if path.startswith("/existing/"):
                n = int(path.rsplit("/", 1)[1])
                src = pages_by_index.get(n, {}).get("_existing_file")
                if src and os.path.isfile(src):
                    return self._send(200, open(src, "rb").read(), "image/png")
                return self._send(404)
            if path.startswith("/art/"):
                rel = path[len("/art/"):]
                from urllib.parse import unquote
                full = _art_file(job, cosmos_abs, unquote(rel))
                if full and os.path.isfile(full):
                    ctype = "image/png" if full.lower().endswith(".png") else "text/plain"
                    return self._send(200, open(full, "rb").read(), ctype)
                return self._send(404)
            return self._send(404)

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length)
            path = self.path.split("?")[0]
            if path.startswith("/page/"):
                n = int(path.rsplit("/", 1)[1])
                name = pages_by_index[n]["file"] + ".png"
                tmp = os.path.join(out_dir, name + ".tmp")
                with open(tmp, "wb") as f:
                    f.write(body)
                os.replace(tmp, os.path.join(out_dir, name))
                return self._send(200)
            if path == "/done":
                try:
                    result.update(json.loads(body.decode("utf-8") or "{}"))
                except ValueError:
                    result.update({"rendered": [], "failed": [{"key": "*", "error": "bad report"}]})
                done.set()
                return self._send(200)
            return self._send(404)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/portrait.html"
    proc = None
    profile = tempfile.mkdtemp(prefix="sbs-portraits-")
    try:
        if show:
            import webbrowser
            webbrowser.open(url)
        else:
            exe = find_browser(browser)
            if exe is None:
                raise click.ClickException(
                    "no Edge or Chrome found to render with. Pass --browser <path>, or "
                    "--show to use your default browser.")
            proc = subprocess.Popen(
                [exe, "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                 "--no-first-run", "--no-default-browser-check", "--disable-extensions",
                 f"--user-data-dir={profile}", url],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        n = sum(len(p["items"]) for p in job["pages"])
        limit = timeout or (60 + 5 * n)
        if not done.wait(limit):
            raise click.ClickException(f"the renderer did not finish within {limit} s")
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    return result


def _art_file(job, cosmos, rel):
    """Resolve a requested art URL to a file, inside the Cosmos root or the job's mod
    folder only - the page is handed hull roots, never arbitrary paths."""
    rel = rel.replace("\\", "/").lstrip("/")
    for prefix, base in job.get("_roots", {}).items():
        if rel.startswith(prefix + "/"):
            full = os.path.normpath(os.path.join(base, *rel[len(prefix) + 1:].split("/")))
            return full if full.startswith(os.path.normpath(base)) else None
    full = os.path.normpath(os.path.join(cosmos, *rel.split("/")))
    return full if full.startswith(os.path.normpath(cosmos)) else None


# ---------------------------------------------------------------------------------------
# The command
# ---------------------------------------------------------------------------------------
def _sources(cosmos, missions, folder):
    """(ship-data files, output folder, set name, mod media folder or None)."""
    if not folder:
        return ([os.path.join(cosmos, "data", "shipData.yaml")],
                os.path.join(missions, "sbs_utils", "media", "ship_portraits"), "base", None)
    base = folder if os.path.isdir(folder) else os.path.join(missions, folder)
    base = os.path.abspath(base)
    media = os.path.join(base, "media")
    files = []
    for root, _dirs, names in os.walk(media):
        if "ship_portraits" in root:
            continue
        for n in names:
            if n.lower().endswith((".json", ".yaml")) and "ship" in n.lower():
                files.append(os.path.join(root, n))
    set_name = re.sub(r"[^a-z0-9]+", "", os.path.basename(base).lower()) or "mod"
    return sorted(files), os.path.join(media, "ship_portraits"), set_name, media


def portraits_impl(folder=None, set_name=None, keys=None, include_all=False, force=False,
                   check=False, dry_run=False, show=False, browser=None, cell=DEFAULT_CELL,
                   cols=DEFAULT_COLS, cosmos=None, missions=None, renderer=None):
    """The whole command, with every input injectable for tests. `renderer` replaces
    `render` (same signature)."""
    if cosmos is None:
        cosmos, missions = cosmos_root()
    sources, out_dir, default_set, mod_media = _sources(cosmos, missions, folder)
    set_name = set_name or default_set
    alias = "shp_" + set_name
    cell = (int(cell), int(cell))
    hulls = collect_hulls(sources, include_all)
    if keys:
        want = {k.strip() for k in keys.split(",") if k.strip()}
        hulls = [h for h in hulls if h["key"] in want]
    manifest_path = os.path.join(out_dir, set_name + ".json")
    try:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError):
        manifest = None

    wanted, roots, arts, missing = {}, {}, {}, []
    for h in hulls:
        root = art_path(cosmos, h["art"], mod_media)
        if root is None:
            missing.append(h)
            continue
        wanted[h["key"]] = signature(root, cell)
        roots[h["key"]] = root
        arts[h["key"]] = h["art"]
    for name in EXTRAS:
        wanted["#" + name] = extra_signature(name, cell)
    if keys and manifest:
        # A partial run keeps every other cell exactly as it was.
        for key, at in (manifest.get("cells") or {}).items():
            if key not in wanted:
                wanted[key] = at.get("sig")
                arts[key] = at.get("art", "")

    cells, todo, cleared = plan(manifest, wanted, cols, cell, force)
    print(f"ship portraits '{set_name}': {len(cells) - len(EXTRAS)} hulls, "
          f"{len(todo)} to draw, {len(cleared)} freed -> {out_dir}")
    for h in missing:
        print(f"  !!  {h['key']}: no art at '{h['art']}' - skipped")
    if check:
        for k in todo:
            print(f"  stale  {k}")
        return 1 if todo or cleared else 0
    if dry_run:
        for k in todo:
            print(f"  draw   {k}")
        return 0
    new_manifest = build_manifest(set_name, alias, cell, cols, cells, arts)
    if not todo and not cleared and manifest == new_manifest:
        print("  up to date")
        return 0

    os.makedirs(out_dir, exist_ok=True)
    files = find_mockgui(missions)
    if files is None:
        raise click.ClickException("the portrait renderer (cosmos_dev/mockgui/portrait.html) "
                                   "was not found - run `sbs fetch . --update-libs`.")
    # The page asks for hull art by URL. Mod art outside the Cosmos root is served under
    # a private prefix.
    job_roots, item_root, by_dir = {}, {}, {}
    for key in todo:
        if key.startswith("#"):
            continue
        root = os.path.abspath(roots[key])
        rel = os.path.relpath(root, cosmos).replace("\\", "/") \
            if root.startswith(os.path.abspath(cosmos)) else None
        if rel is None or rel.startswith(".."):
            folder_of = os.path.dirname(root)
            prefix = by_dir.setdefault(folder_of, f"_ext{len(by_dir)}")
            job_roots[prefix] = folder_of
            rel = prefix + "/" + os.path.basename(root)
        item_root[key] = rel
    pages = []
    for p, page in enumerate(new_manifest["pages"]):
        existing = os.path.join(out_dir, page["file"] + ".png")
        pages.append({
            "index": p, "file": page["file"], "rows": page["rows"],
            "existing": f"/existing/{p}" if os.path.isfile(existing) else None,
            "_existing_file": existing,
            "clear": [c for c in cleared if c["page"] == p],
            "items": [{"key": k, "col": cells[k]["col"], "row": cells[k]["row"],
                       "root": item_root.get(k),
                       "extra": k[1:] if k.startswith("#") else None}
                      for k in todo if cells[k]["page"] == p],
        })
    job = {"cell": list(cell), "cols": cols, "preset": PRESET, "pages": pages,
           "_roots": job_roots}
    result = (renderer or render)(job, files, cosmos, out_dir, browser=browser, show=show)
    failed = {f.get("key"): f.get("error") for f in result.get("failed") or []}
    for key, err in failed.items():
        print(f"  FAIL  {key}: {err}")
        if key in cells:
            # Not drawn, so not current: the next run tries again.
            cells[key]["sig"] = None
    new_manifest = build_manifest(set_name, alias, cell, cols, cells, arts)
    tmp = manifest_path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(new_manifest, indent=1, sort_keys=True) + "\n")
    os.replace(tmp, manifest_path)
    print(f"  drew {len(result.get('rendered') or [])}, failed {len(failed)}")
    return 1 if failed else 0


@art.command("portraits")
@click.argument("folder", default=None, required=False)
@click.option("--set", "set_name", default=None, help="Set name (default: base, or the mod folder).")
@click.option("--keys", default=None, help="Comma-separated hull keys to (re)draw; others are kept.")
@click.option("--all", "include_all", is_flag=True, help="Include entries with no hullpoints (pickups, asteroids).")
@click.option("--force", is_flag=True, help="Redraw every cell.")
@click.option("--check", is_flag=True, help="Report stale/missing cells; exit 1 if any. Draws nothing.")
@click.option("--dry-run", is_flag=True, help="List what would be drawn.")
@click.option("--show", is_flag=True, help="Render in your default browser instead of headless.")
@click.option("--browser", default=None, help="Path to Edge/Chrome for headless rendering.")
@click.option("--cell", default=DEFAULT_CELL, show_default=True, help="Cell size in pixels (square).")
def art_portraits(folder, set_name, keys, include_all, force, check, dry_run, show, browser, cell):
    """Render ship portraits (a face/image sheet) for the base game or a mod.

    With no FOLDER: every base-game hull, into sbs_utils/media/ship_portraits. With a mod
    or mission FOLDER: the hulls in its media ship-data files, into its own
    media/ship_portraits. Only changed or new hulls are drawn.
    """
    raise SystemExit(portraits_impl(folder, set_name, keys, include_all, force, check,
                                    dry_run, show, browser, cell))
