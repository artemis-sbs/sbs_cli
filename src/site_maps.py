"""`sbs site --emit site`: a page per tile map, the whole area drawn with its real art.

The engine's tile view can never show a big map at once (it is capped at 40 columns: a
tile is two widgets, and huge GUI sections crash the engine), and the VS Code editor is
an editing tool. So the site gets one page per `.tiles` area - zoomable, printable, and
linked both ways with the records that stand on it.

WHAT IS DRAWN IS DECIDED IN PYTHON. `tilemap_preview_file` runs the game's own look
functions (variants, edges, fringes, a figure's mirrored side, a prop's mirrored twin)
and hands back keys and rects; `TILEMAP_JS` only blits them. A renderer that made its
own look decisions would drift from the game the first time either changed - the
face.js lesson.

Drawn in the BROWSER, not rasterized here: `sbs.bat` runs the engine's own Python, which
has no Pillow, and a canvas can zoom.
"""
import html
import json
import os
import shutil

#: Where the map pages go. Not `maps/`: a mission may have `.amd` files in a folder of
#: that name, and their pages would share it.
MAPS_DIR = "tilemaps"


def map_areas(mission):
    """Every `.tiles` area the mission has: `[(key, path)]`, sorted by key."""
    from sbs_utils.procedural.tilemap_lint import tilemap_world
    world = tilemap_world(mission)
    return sorted((world.get("area_paths") or {}).items())


def record_links(pages, amd_markdown):
    """`{(amd file relative to the mission, record key): "page.html#anchor"}` - where each
    record lives on the site, so a thing on a map links to its record."""
    out = {}
    for page in pages:
        rel_page = page["path"][:-3] + ".html" if page["path"].endswith(".md") \
            else page["path"] + ".html"
        doc = page.get("doc")
        uri = getattr(doc, "rel_path", None) or page.get("uri")
        for node in page.get("nodes") or ():
            key = getattr(node, "key", None)
            if key:
                out.setdefault((uri, str(key).lower()),
                               f"{rel_page}#{amd_markdown.amd_markdown_anchor(node)}")
    return out


def collect(mission, pages, amd_markdown, profile="author"):
    """One entry per area: `{key, title, rel, data}`, `data` being what the page draws."""
    from sbs_utils.procedural.tilemap_preview import tilemap_preview_file
    links = record_links(pages, amd_markdown)
    areas = map_areas(mission)
    rels = {key: f"{MAPS_DIR}/{key}.html" for key, _ in areas}
    out = []
    for key, path in areas:
        try:
            data = tilemap_preview_file(path, mission)
        except Exception as e:                           # noqa: BLE001
            data = {"ok": False, "error": str(e)}
        if not data.get("ok"):
            out.append({"key": key, "title": key, "rel": rels[key], "data": None,
                        "error": data.get("error") or "cannot read the area",
                        "source": os.path.relpath(path, mission).replace(os.sep, "/")})
            continue
        area = data["area"]
        out.append({"key": key, "title": area.get("title") or key, "rel": rels[key],
                    "source": os.path.relpath(path, mission).replace(os.sep, "/"),
                    "data": _page_data(mission, data, links, rels, profile)})
    # An exit says where it goes by that place's name, known once every area is read.
    titles = {m["key"]: m["title"] for m in out}
    for m in out:
        for x in ((m["data"] or {}).get("exits") or {}).values():
            x["title"] = titles.get(x["area"])
    return out


def _page_data(mission, data, links, rels, profile):
    """Only what the page draws - and for a PLAYER, nothing a player should not see:
    no hidden things, no hostiles, no patrols, and only the marks that are ways out."""
    player = profile == "player"
    exits = {}
    for mark, target in (data.get("exits") or {}).items():
        area = str(target).split(" ")[0].strip().lower()
        exits[mark] = {"area": area,
                       "href": os.path.basename(rels[area]) if area in rels else None}
    marks = data.get("marks") or {}
    if player:
        marks = {m: c for m, c in marks.items() if m in exits}
    things = []
    for p in data.get("placements") or ():
        if not p.get("cell"):
            continue
        if player and (p.get("hidden") or p.get("kind") == "hostile"):
            continue
        uri = os.path.relpath(p["uri"], mission).replace(os.sep, "/") \
            if p.get("uri") and os.path.isabs(p["uri"]) else p.get("uri")
        link = links.get((uri, str(p["key"]).lower()))
        things.append({"key": p["key"], "name": p.get("display") or p["key"],
                       "kind": p.get("kind"), "cell": p["cell"], "look": p.get("look"),
                       "color": p.get("color"), "calm": bool(p.get("calm")),
                       "hidden": bool(p.get("hidden")),
                       "patrol": [] if player else [[q["x"], q["y"]] for q in
                                                    p.get("patrol") or ()],
                       "href": f"../{link}" if link else None})
    drawn = {k for row in data["looks"] for k in row if k} \
        | {k for _, _, ks in data["fringes"] for k in ks} \
        | {t["look"] for t in things if t["look"]}
    sprites = {k: v for k, v in (data.get("sprites") or {}).items() if k in drawn}
    # A generated deck's rooms are marks named `room:<name>`: labeled by the name.
    labels = {m: m[5:].replace("-", " ") for m in marks if m.startswith("room:")}
    if labels and "entry" in marks:
        labels["entry"] = "way in"
    return {"area": data["area"], "tiles": data["tiles"], "looks": data["looks"],
            "fringes": data["fringes"], "sprites": sprites, "marks": marks,
            "exits": exits, "things": things, "labels": labels,
            "kinds": {k: {"walk": v.get("walk"), "see": v.get("see")}
                      for k, v in (data.get("kinds") or {}).items()},
            "missing": data.get("missing") or []}


#: Where the ship deck pages go, and the nav groups both kinds of page are listed under.
DECKS_DIR = "decks"
MAPS_GROUP = "Maps"
DECKS_GROUP = "Ship decks"


def deck_title(ship):
    """`tsn_light_cruiser` -> `TSN Light Cruiser`: a short first word is a faction's
    initials."""
    words = str(ship).replace("-", "_").split("_")
    return " ".join(w.upper() if i == 0 and len(w) <= 3 else w.capitalize()
                    for i, w in enumerate(words) if w)


def collect_decks(mission, profile="author"):
    """One entry per ship interior plan (`.grid`) the mission has: the boarding deck the
    library generates from it (`tilemap_preview_deck`), as `{key, title, rel, data}`."""
    import re
    from sbs_utils.procedural.tilemap_preview import tilemap_preview_deck
    plans = []
    for root, dirs, files in os.walk(mission):
        dirs[:] = sorted(d for d in dirs if not d.startswith((".", "_")) and d != "mkdocs")
        plans += [os.path.join(root, f) for f in sorted(files) if f.endswith(".grid")]
    out, seen = [], set()
    for path in plans:
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        if not re.search(r"^ship\s*:", text, re.M):
            continue
        source = os.path.relpath(path, mission).replace(os.sep, "/")
        try:
            data = tilemap_preview_deck(text, mission)
        except Exception as e:                           # noqa: BLE001
            data = {"ok": False, "error": str(e)}
        ship = (data.get("ship") if data.get("ok") else None) or \
            os.path.splitext(os.path.basename(path))[0]
        key = str(ship).lower()
        n = 2
        while key in seen:
            key = f"{str(ship).lower()}-{n}"
            n += 1
        seen.add(key)
        entry = {"key": f"deck-{key}", "title": deck_title(ship),
                 "rel": f"{DECKS_DIR}/{key}.html", "source": source, "deck": True,
                 "data": None, "error": data.get("error")}
        if data.get("ok"):
            entry["data"] = _page_data(mission, data, {}, {}, profile)
        out.append(entry)
    return sorted(out, key=lambda m: m["title"])


def extra_pages(maps, decks):
    """The site pages for the maps and decks: each map in the nav under Maps; the decks
    - there can be a hundred - through ONE index page in the nav, not a hundred entries."""
    pages = [{"title": m["title"], "rel": m["rel"], "body": page_body(m),
              "group": MAPS_GROUP, "kind": "Map"} for m in maps]
    if decks:
        pages.append({"title": "Every ship deck", "rel": f"{DECKS_DIR}/index.html",
                      "body": decks_index_body(decks), "group": DECKS_GROUP,
                      "kind": "Ship decks"})
        pages += [{"title": f'{d["title"]} deck', "rel": d["rel"], "body": page_body(d),
                   "group": None, "kind": "Ship deck"} for d in decks]
    return pages


def home_markdown(maps, decks):
    """What the home page says about the maps and decks, as markdown."""
    lines = []
    if maps:
        lines += ["## Maps", "", "| Map | Size |", "|---|---|"]
        for m in maps:
            a = (m.get("data") or {}).get("area") or {}
            size = f'{a["w"]} x {a["h"]}' if a else "unreadable"
            lines.append(f'| [{m["title"]}]({m["rel"]}) | {size} |')
        lines.append("")
    if decks:
        lines += ["## Ship decks", "",
                  f"The boarding deck of each of the {len(decks)} ship interiors, as a "
                  f"boarding party would walk it: [every ship deck]({DECKS_DIR}/index.html).",
                  ""]
    return "\n".join(lines)


def decks_index_body(decks):
    e = html.escape
    out = ["<h1>Ship decks</h1>",
           '<p>The deck a boarding party walks on each ship, generated from its interior '
           'plan: rooms furnished by what they are for, walls, doors and the way in.</p>',
           "<table><tr><th>Ship</th><th>Size</th><th>Rooms</th><th>Plan</th></tr>"]
    for d in decks:
        name = os.path.basename(d["rel"])
        if d["data"]:
            a = d["data"]["area"]
            rooms = len(d["data"].get("labels") or {})
            out.append(f'<tr><td><a href="{e(name)}">{e(d["title"])}</a></td>'
                       f'<td>{a["w"]} x {a["h"]}</td><td>{rooms}</td>'
                       f'<td><code>{e(d["source"])}</code></td></tr>')
        else:
            out.append(f'<tr><td>{e(d["title"])}</td><td colspan="2">unreadable: '
                       f'{e(d.get("error") or "")}</td><td><code>{e(d["source"])}</code>'
                       f'</td></tr>')
    out.append("</table>")
    return "\n".join(out)


def stage_sheets(maps, media_dir):
    """Copy every sheet the maps draw from ONCE into the site's media folder, and point
    each sprite at its copy (relative to a map page). `media_dir` is the folder the site
    publishes as `media/`."""
    copied = {}
    taken = set()
    for m in maps:
        if not m["data"]:
            continue
        for sp in m["data"]["sprites"].values():
            src = sp["sheet"]
            if src not in copied:
                folder = os.path.basename(os.path.dirname(src)) or "art"
                name = f"{folder}/{os.path.basename(src)}"
                n = 2
                while name in taken:
                    name = f"{folder}-{n}/{os.path.basename(src)}"
                    n += 1
                taken.add(name)
                dest = os.path.join(media_dir, "tileart", *name.split("/"))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                if os.path.isfile(src):
                    shutil.copyfile(src, dest)
                copied[src] = f"../media/tileart/{name}"
            sp["sheet"] = copied[src]
    return len(copied)


def write_assets(maps, out_dir):
    """`assets/tilemap.js` and one data script per map, `assets/maps/<key>.js` - a
    script that assigns a global, because `fetch()` is blocked on `file://`."""
    assets = os.path.join(out_dir, "assets")
    data_dir = os.path.join(assets, "maps")
    if os.path.isdir(data_dir):
        shutil.rmtree(data_dir)
    os.makedirs(data_dir, exist_ok=True)
    with open(os.path.join(assets, "tilemap.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write(TILEMAP_JS)
    for m in maps:
        if not m["data"]:
            continue
        with open(os.path.join(data_dir, m["key"] + ".js"), "w", encoding="utf-8",
                  newline="\n") as f:
            f.write("(window.TILE_MAPS = window.TILE_MAPS || {})[" + json.dumps(m["key"])
                    + "] = " + json.dumps(m["data"], ensure_ascii=False,
                                          separators=(",", ":")) + ";\n")


def page_body(m):
    """The HTML inside `<main>` for one map page."""
    e = html.escape
    if not m["data"]:
        return (f'<h1>{e(m["title"])}</h1><p>This map could not be read: '
                f'{e(m.get("error") or "")} (<code>{e(m["source"])}</code>).</p>')
    d = m["data"]
    a = d["area"]
    deck = m.get("deck")
    if deck:
        out = [f'<h1>{e(m["title"])} deck</h1>',
               f'<p class="map-meta">{a["w"]} x {a["h"]} tiles - generated from the ship\'s '
               f'interior plan <code>{e(m["source"])}</code> - '
               f'<a href="index.html">every ship deck</a></p>']
    else:
        out = [f'<h1>{e(m["title"])}</h1>',
               f'<p class="map-meta">{a["w"]} x {a["h"]} tiles - tileset '
               f'<code>{e(a.get("tileset") or "")}</code> - <code>{e(m["source"])}</code></p>']
    if d.get("missing"):
        out.append('<p class="map-meta">No art found for set(s): '
                   + ", ".join(f"<code>{e(s)}</code>" for s in d["missing"]) + "</p>")
    patrols = "" if deck else \
        '<label><input type="checkbox" data-layer="patrols" checked> Patrols</label>\n'
    out.append(f'''<div class="tile-map" data-map="{e(m["key"])}">
<div class="map-tools">
<button type="button" data-zoom="-1" title="Zoom out">-</button>
<button type="button" data-zoom="1" title="Zoom in">+</button>
<button type="button" data-fit title="Fit the width">Fit</button>
<label><input type="checkbox" data-layer="marks" checked> {"Rooms" if deck else "Marks"}</label>
<label><input type="checkbox" data-layer="things" checked> {"Furniture" if deck else "Things"}</label>
{patrols}<label><input type="checkbox" data-layer="grid"> Grid</label>
<span class="map-hover"></span>
</div>
<div class="map-scroll"><canvas></canvas></div>
</div>''')
    exits = sorted(d["exits"].items())
    if exits:
        out.append('<h2 id="exits">Exits</h2><ul class="map-list">')
        for mark, x in exits:
            name = e(x.get("title") or x["area"])
            link = f'<a href="{e(x["href"])}">{name}</a>' if x["href"] else name
            out.append(f"<li><code>@{e(mark)}</code> to {link}</li>")
        out.append("</ul>")
    if deck:
        # A deck's things are its furniture - a hundred bunks and doors say nothing a
        # list could. Its ROOMS are what a reader looks for.
        rooms = sorted(set((d.get("labels") or {}).values()))
        if rooms:
            out.append('<h2 id="rooms">Rooms</h2><p>' + ", ".join(e(r) for r in rooms)
                       + "</p>")
    elif d["things"]:
        out.append('<h2 id="things">On this map</h2><ul class="map-list">')
        for t in sorted(d["things"], key=lambda t: (t["kind"] or "", t["name"])):
            name = e(t["name"])
            link = f'<a href="{e(t["href"])}">{name}</a>' if t["href"] else name
            notes = [t["kind"] or ""] + (["hidden"] if t["hidden"] else []) \
                + (["calm"] if t["calm"] and t["kind"] == "hostile" else [])
            out.append(f'<li>{link} <span class="map-meta">'
                       f'{e(", ".join(n for n in notes if n))} at {t["cell"][0]}, '
                       f'{t["cell"][1]}</span></li>')
        out.append("</ul>")
    if d["kinds"] and not deck:
        out.append('<h2 id="ground">Ground</h2><table><tr><th>Kind</th><th>Walked</th>'
                   '<th>Seen through</th></tr>')
        for kind, rules in sorted(d["kinds"].items()):
            def yes(v):
                return "?" if v is None else ("yes" if v else "no")
            out.append(f'<tr><td><code>{e(kind)}</code></td><td>{yes(rules["walk"])}</td>'
                       f'<td>{yes(rules["see"])}</td></tr>')
        out.append("</table>")
    out.append(f'<script src="../assets/maps/{e(m["key"])}.js"></script>'
               '<script src="../assets/tilemap.js"></script>')
    return "\n".join(out)


def print_pdfs(maps, out_dir):
    """`maps/<key>.pdf` for each map, printed by an installed Edge or Chrome, headless.
    Returns `(written, browser or None)`."""
    import subprocess
    browser = _find_browser()
    if browser is None:
        return [], None
    written = []
    for m in maps:
        if not m["data"]:
            continue
        page = os.path.join(out_dir, *m["rel"].split("/"))
        pdf = page[:-5] + ".pdf"
        url = "file:///" + page.replace(os.sep, "/")
        try:
            subprocess.run([browser, "--headless=new", "--disable-gpu",
                            "--allow-file-access-from-files", "--no-pdf-header-footer",
                            "--virtual-time-budget=8000", f"--print-to-pdf={pdf}", url],
                           capture_output=True, timeout=120)
        except Exception:                                # noqa: BLE001
            continue
        if os.path.isfile(pdf):
            written.append(os.path.relpath(pdf, out_dir).replace(os.sep, "/"))
    return written, browser


def _find_browser():
    candidates = []
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"),
                 os.environ.get("LOCALAPPDATA")):
        if base:
            candidates += [os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                           os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")]
    for name in ("msedge", "google-chrome", "chromium", "chrome"):
        found = shutil.which(name)
        if found:
            candidates.append(found)
    return next((c for c in candidates if c and os.path.isfile(c)), None)


MAPS_CSS = """
/* Map pages use the whole width; the map scrolls inside its own box. */
.layout:has(.tile-map) { max-width: none; }
.map-meta { color: var(--muted); font-size: .9em; }
.tile-map { border: 1px solid var(--line); border-radius: 8px; background: var(--panel);
  margin: 1rem 0; }
.map-tools { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem;
  padding: .45rem .6rem; border-bottom: 1px solid var(--line); font-size: .9em; }
.map-tools button { min-width: 2.2rem; padding: .15rem .6rem; border: 1px solid var(--line);
  border-radius: 6px; background: var(--bg); color: var(--fg); cursor: pointer; }
.map-tools label { display: inline-flex; align-items: center; gap: .25rem; }
.map-hover { margin-left: auto; color: var(--muted); font-family: monospace; }
.map-scroll { overflow: auto; max-height: 78vh; background: #000; }
.map-scroll canvas { display: block; margin: 0 auto; }
.map-list { padding-left: 1.2rem; }
@media print {
  .topbar, .site-nav, .toc, .map-tools { display: none !important; }
  .layout { display: block; padding: 0; max-width: none; }
  .tile-map { border: 0; margin: 0; background: none; }
  .map-scroll { overflow: visible; max-height: none; background: none; }
  /* As big as fits UNDER the title on one landscape page, its shape kept. */
  .map-scroll canvas { width: auto !important; height: auto !important;
    max-width: 100%; max-height: 165mm; }
  .content h1 { margin: 0 0 .2rem; font-size: 1.4rem; }
  .tile-map { break-after: page; }
  @page { size: landscape; margin: 10mm; }
}
"""

TILEMAP_JS = r"""// Draws a tile map from the data `sbs site` wrote. It makes NO look decisions - every
// key, rect and mirror comes from sbs_utils (tilemap_preview) - it only blits them.
(function () {
  var ZOOMS = [6, 8, 12, 16, 20, 24, 32, 40, 48, 64];
  function el(root, sel) { return root.querySelector(sel); }

  function MapView(root, d) {
    var canvas = el(root, 'canvas'), hover = el(root, '.map-hover');
    var ctx = canvas.getContext('2d');
    var images = {}, cuts = {}, z = 16, layers = { marks: true, things: true,
      patrols: true, grid: false };
    var at = {};
    (d.things || []).forEach(function (t) { at[t.cell[0] + ',' + t.cell[1]] = t; });

    function image(src) {
      if (!images[src]) {
        var img = new Image();
        img.onload = draw;
        img.src = src;
        images[src] = img;
      }
      return images[src];
    }
    // One sprite cut from its sheet, flipped when its rect runs backwards (a mirrored
    // look), and tinted by multiply with its alpha put back - as the game tints.
    function cut(key, color) {
      var sp = d.sprites[key];
      if (!sp) return null;
      var img = image(sp.sheet);
      if (!img.complete || !img.naturalWidth) return null;
      var id = key + '|' + (color || '');
      if (cuts[id]) return cuts[id];
      var r = sp.rect, x0 = Math.min(r[0], r[2]), y0 = Math.min(r[1], r[3]);
      var fx = r[2] < r[0], fy = r[3] < r[1];
      var c = document.createElement('canvas');
      c.width = Math.abs(r[2] - r[0]); c.height = Math.abs(r[3] - r[1]);
      var g = c.getContext('2d');
      g.setTransform(fx ? -1 : 1, 0, 0, fy ? -1 : 1, fx ? c.width : 0, fy ? c.height : 0);
      g.drawImage(img, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
      if (color) {
        g.globalCompositeOperation = 'multiply';
        g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(img, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
      }
      cuts[id] = c;
      return c;
    }
    function tile(key, x, y) {
      var sp = d.sprites[key], c = sp && cut(key, sp.color);
      if (c) ctx.drawImage(c, x * z, y * z, z, z);
    }
    function figure(t) {
      var sp = t.look && d.sprites[t.look];
      var c = sp && cut(t.look, t.color || sp.color);
      if (!c) {                                 // no art: a dot, so it is still there
        ctx.fillStyle = t.kind === 'hostile' ? '#e44' : '#e8b04a';
        ctx.beginPath();
        ctx.arc((t.cell[0] + .5) * z, (t.cell[1] + .5) * z, z * .3, 0, 7);
        ctx.fill();
        return;
      }
      var fw = (sp.cells || [1, 1])[0], fh = (sp.cells || [1, 1])[1];
      var ax = (sp.anchor || [.5, 1])[0], ay = (sp.anchor || [.5, 1])[1];
      var footX = (t.cell[0] + .5) * z, footY = (t.cell[1] + 1) * z;
      ctx.drawImage(c, footX - ax * fw * z, footY - ay * fh * z, fw * z, fh * z);
    }
    function draw() {
      var w = d.area.w, h = d.area.h;
      canvas.width = w * z; canvas.height = h * z;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++)
          if (d.looks[y][x]) tile(d.looks[y][x], x, y);
      (d.fringes || []).forEach(function (f) {
        f[2].forEach(function (k) { tile(k, f[0], f[1]); });
      });
      if (layers.grid) {
        ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
        for (var gx = 0; gx <= w; gx++) { ctx.beginPath(); ctx.moveTo(gx * z + .5, 0);
          ctx.lineTo(gx * z + .5, h * z); ctx.stroke(); }
        for (var gy = 0; gy <= h; gy++) { ctx.beginPath(); ctx.moveTo(0, gy * z + .5);
          ctx.lineTo(w * z, gy * z + .5); ctx.stroke(); }
      }
      if (layers.patrols) {
        ctx.setLineDash([z / 4, z / 6]); ctx.lineWidth = Math.max(1, z / 12);
        ctx.strokeStyle = 'rgba(255,90,90,.85)';
        (d.things || []).forEach(function (t) {
          if (!t.patrol || !t.patrol.length) return;
          ctx.beginPath();
          ctx.moveTo((t.cell[0] + .5) * z, (t.cell[1] + .5) * z);
          t.patrol.forEach(function (p) { ctx.lineTo((p[0] + .5) * z, (p[1] + .5) * z); });
          ctx.stroke();
        });
        ctx.setLineDash([]);
      }
      if (layers.things) {
        (d.things || []).slice().sort(function (a, b) {
          return a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0];
        }).forEach(figure);
      }
      if (layers.marks) {
        ctx.font = Math.max(9, Math.round(z * .45)) + 'px sans-serif';
        Object.keys(d.marks || {}).forEach(function (m) {
          var exit = d.exits && d.exits[m];
          // The mark's OUTLINE - only the edges it does not share with itself - over a
          // light wash, so a thirty-cell pad is one shape, not thirty boxes.
          var cells = d.marks[m], inMark = {};
          cells.forEach(function (c) { inMark[c[0] + ',' + c[1]] = 1; });
          ctx.fillStyle = exit ? 'rgba(111,181,240,.18)' : 'rgba(255,220,120,.12)';
          cells.forEach(function (c) { ctx.fillRect(c[0] * z, c[1] * z, z, z); });
          ctx.strokeStyle = exit ? '#6fb5f0' : 'rgba(255,220,120,.9)';
          ctx.lineWidth = Math.max(1, z / 12);
          ctx.beginPath();
          cells.forEach(function (c) {
            var x = c[0] * z, y = c[1] * z;
            if (!inMark[c[0] + ',' + (c[1] - 1)]) { ctx.moveTo(x, y); ctx.lineTo(x + z, y); }
            if (!inMark[c[0] + ',' + (c[1] + 1)]) { ctx.moveTo(x, y + z); ctx.lineTo(x + z, y + z); }
            if (!inMark[(c[0] - 1) + ',' + c[1]]) { ctx.moveTo(x, y); ctx.lineTo(x, y + z); }
            if (!inMark[(c[0] + 1) + ',' + c[1]]) { ctx.moveTo(x + z, y); ctx.lineTo(x + z, y + z); }
          });
          ctx.stroke();
          var c0 = cells[0];
          if (c0 && z >= 12) {
            var label = exit ? '> ' + (exit.title || exit.area)
                             : (d.labels && d.labels[m]) || '@' + m;
            var lh = z * .55, tw = ctx.measureText(label).width;
            // Above the mark, or inside it when it is on the top row.
            var ly = c0[1] > 0 ? c0[1] * z - lh : c0[1] * z;
            var lx = Math.min(c0[0] * z, canvas.width - tw - 6);
            ctx.fillStyle = 'rgba(0,0,0,.6)';
            ctx.fillRect(lx, ly, tw + 6, lh);
            ctx.fillStyle = '#fff';
            ctx.fillText(label, lx + 3, ly + lh * .78);
          }
        });
      }
    }
    function fit() {
      var box = el(root, '.map-scroll');
      // Exactly the width, not the nearest step below it; the steps are for +/-.
      z = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1],
                                      Math.floor((box.clientWidth - 2) / d.area.w)));
      draw();
    }
    function zoom(dir) {
      // The next step up or down from wherever Fit left it.
      var next = dir > 0 ? ZOOMS.filter(function (v) { return v > z; })[0]
                         : ZOOMS.filter(function (v) { return v < z; }).pop();
      if (next === undefined) return;
      z = next;
      draw();
    }
    root.querySelectorAll('[data-zoom]').forEach(function (b) {
      b.addEventListener('click', function () { zoom(+b.getAttribute('data-zoom')); });
    });
    var f = el(root, '[data-fit]');
    if (f) f.addEventListener('click', fit);
    root.querySelectorAll('[data-layer]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        layers[cb.getAttribute('data-layer')] = cb.checked; draw();
      });
    });
    el(root, '.map-scroll').addEventListener('wheel', function (ev) {
      if (!ev.ctrlKey) return;
      ev.preventDefault(); zoom(ev.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    function cellOf(ev) {
      var r = canvas.getBoundingClientRect();
      return [Math.floor((ev.clientX - r.left) * canvas.width / r.width / z),
              Math.floor((ev.clientY - r.top) * canvas.height / r.height / z)];
    }
    canvas.addEventListener('mousemove', function (ev) {
      var c = cellOf(ev), x = c[0], y = c[1];
      if (!hover || x < 0 || y < 0 || x >= d.area.w || y >= d.area.h) return;
      var bits = [x + ', ' + y, (d.tiles[y] && d.tiles[y][x]) || 'nothing'];
      Object.keys(d.marks || {}).forEach(function (m) {
        d.marks[m].forEach(function (p) { if (p[0] === x && p[1] === y) bits.push('@' + m); });
      });
      var t = at[x + ',' + y];
      if (t) bits.push(t.name);
      hover.textContent = bits.join('  ');
    });
    canvas.addEventListener('click', function (ev) {
      var c = cellOf(ev), t = at[c[0] + ',' + c[1]];
      if (t && t.href) { location.href = t.href; return; }
      Object.keys(d.exits || {}).forEach(function (m) {
        (d.marks[m] || []).forEach(function (p) {
          if (p[0] === c[0] && p[1] === c[1] && d.exits[m].href) location.href = d.exits[m].href;
        });
      });
    });
    // Printed at a resolution a page can use, then put back.
    var before = null;
    window.addEventListener('beforeprint', function () {
      before = z;
      z = Math.max(8, Math.min(64, Math.floor(2400 / d.area.w))); draw();
    });
    window.addEventListener('afterprint', function () {
      if (before !== null) { z = before; before = null; draw(); }
    });
    fit();
  }

  document.querySelectorAll('.tile-map').forEach(function (root) {
    var d = (window.TILE_MAPS || {})[root.getAttribute('data-map')];
    if (d) MapView(root, d);
  });
})();
"""
