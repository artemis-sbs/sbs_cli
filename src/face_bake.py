"""Bake a `face://` composite to a PNG, at generate time.

A face string is not a path - it is a layer stack over a race atlas
(`arv #ffffff 0 0;arv #ffffff 0 2;?height=100`), composited at display time by
`cosmos_dev/mockgui/face.js` on a canvas. A website has three ways to deal with that:

  a. say what was meant to be there and show nothing;
  b. ship `face.js` plus the atlases and composite in the browser;
  c. composite once, here, and ship a small PNG.

(c) wins and it is not close. It works in mkdocs, in the standalone site, in GitHub's
markdown preview and in print, with no JavaScript and no `extra_javascript` entry. (b)
costs about 6.8 MB of atlases committed into a mission repo and still shows nothing
wherever scripting is off.

The compositing rule is `face.js`'s, not a reinvention: crop the cell, and for a
non-white tint multiply the color through and mask back to the sprite's own alpha
(`drawLayer`, face.js:99-123). Geometry and the alias table are READ from that file
rather than copied, so a sheet that gains a column does not silently misalign here.

PIL is required and is already an accepted host-side generator dependency in this
project - `sbs_utils/mkdocs/gen_icon_gallery.py` imports it for the same kind of job.
When it or the atlases are missing, `bake` returns None and the caller falls back to
(a). Both, or neither: never a blank box that claims art exists and failed to load.

Output is CONTENT-ADDRESSED, so an unchanged face is byte-identical across runs and
the committed PNGs produce no diff.
"""
import hashlib
import os
import re

GRID_ROWS = 8
DEFAULT_HEIGHT = 96


class FaceBaker:
    def __init__(self, assets, out_dir, url_prefix, height=DEFAULT_HEIGHT):
        self.assets = assets
        self.out_dir = out_dir
        self.url_prefix = url_prefix.rstrip("/")
        self.height = height
        self._atlas = {}
        self._alias = None
        self._cols = None
        self.baked, self.failed = {}, []

    # --- availability -------------------------------------------------------

    def capable(self):
        """True only when a face can ACTUALLY be produced - PIL present, `face.js`
        readable, and at least one atlas on disk. Checked up front so the caller picks
        one story for the whole page instead of discovering it per image."""
        try:
            import PIL.Image  # noqa: F401
        except Exception:
            return False
        table = self._alias_table()
        if not table:
            return False
        return any(self.assets.find(name) for name in table.values())

    def _alias_table(self):
        if self._alias is None:
            from sbs_utils.procedural.amd_assets import face_alias_table
            self._alias = face_alias_table() or {}
        return self._alias

    def _grid_cols(self, alias):
        """Read from `face.js`'s own `gridCols`, because the Terran sheet is 15 columns
        wide and every other one is 8 - a constant copied here would misalign every
        Terran face the day that changes."""
        if self._cols is None:
            self._cols = {}
            from sbs_utils.procedural.amd_assets import face_js_path
            path = face_js_path()
            src = ""
            if path:
                try:
                    with open(path, encoding="utf-8") as f:
                        src = f.read()
                except OSError:
                    src = ""
            m = re.search(r"gridCols\s*\([^)]*\)\s*\{\s*return\s+"
                          r"(?P<var>\w+)\s*===\s*'(?P<alias>\w+)'\s*\?\s*"
                          r"(?P<wide>\d+)\s*:\s*(?P<normal>\d+)", src)
            if m:
                self._cols = {"__default__": int(m.group("normal")),
                              m.group("alias"): int(m.group("wide"))}
            else:
                self._cols = {"__default__": GRID_ROWS}
        return self._cols.get(alias, self._cols.get("__default__", GRID_ROWS))

    # --- baking -------------------------------------------------------------

    def bake(self, spec):
        """`face://...` spec -> a URL for the written PNG, or None.

        AN ALREADY-BAKED PNG NEEDS NO ATLAS. The name is content-addressed from the
        spec alone, so a face that has been composited once and committed can be
        referenced by anyone - which is what makes the generated pages reproducible on
        a machine with no Cosmos install, CI included. Without this, CI regenerates
        every face as a text note, disagrees with the committed page, and reports drift
        that is not there.

        The one case that still fails is a NEW face on a machine that cannot composite
        it, and that failing is correct: nobody has produced that art yet."""
        layers, height = _parse(spec, self.height)
        if not layers:
            return None
        name = self._name_for(spec)
        url = f"{self.url_prefix}/{name}"
        target = os.path.join(self.out_dir, name)
        if name in self.baked:
            return url
        if os.path.isfile(target):
            self.baked[name] = spec
            return url
        if not self.capable():
            self.failed.append(spec)
            return None
        image = self._composite(layers, height)
        if image is None:
            self.failed.append(spec)
            return None
        os.makedirs(self.out_dir, exist_ok=True)
        image.save(target, optimize=True)
        self.baked[name] = spec
        return url

    def _name_for(self, spec):
        """The PNG's filename, from the SPEC alone - no atlas, no PIL, no compositing.

        Content-addressed for two reasons: an unchanged face is byte-identical run to
        run, so the committed PNGs never churn; and the name can be computed by anyone,
        which is what lets a machine that cannot composite still reference art someone
        else already baked."""
        _layers, height = _parse(spec, self.height)
        digest = hashlib.sha1(f"{spec}|{height}".encode("utf-8")).hexdigest()[:12]
        return f"{digest}.png"

    def _composite(self, layers, height):
        from PIL import Image, ImageChops
        table = self._alias_table()
        out = None
        for layer in layers:
            atlas = self._open(table.get(layer["alias"]))
            if atlas is None:
                continue
            cols = self._grid_cols(layer["alias"])
            cw, ch = atlas.width / cols, atlas.height / GRID_ROWS
            sx = layer["col"] * cw + layer["ox"]
            sy = layer["row"] * ch + layer["oy"]
            box = (int(round(sx)), int(round(sy)),
                   int(round(sx + cw)), int(round(sy + ch)))
            if box[0] < 0 or box[1] < 0 or box[2] > atlas.width or box[3] > atlas.height:
                continue
            cell = atlas.crop(box)
            if out is None:
                scale = height / float(cell.height or 1)
                size = (max(1, int(round(cell.width * scale))), height)
                out = Image.new("RGBA", size, (0, 0, 0, 0))
            cell = cell.resize(out.size, Image.LANCZOS)
            rgb = layer["rgb"]
            if rgb != (255, 255, 255):
                # face.js: multiply the tint through, then mask back to the sprite's
                # own alpha - so the tint colors the glyph and not its transparent
                # surround.
                tint = Image.new("RGB", cell.size, rgb)
                tinted = ImageChops.multiply(cell.convert("RGB"), tint).convert("RGBA")
                tinted.putalpha(cell.getchannel("A"))
                cell = tinted
            out.alpha_composite(cell)
        return out

    def _open(self, name):
        if not name:
            return None
        if name not in self._atlas:
            from PIL import Image
            path = self.assets.find(name)
            try:
                self._atlas[name] = (Image.open(path).convert("RGBA")
                                     if path else None)
            except Exception:
                self._atlas[name] = None
        return self._atlas[name]


RE_LAYER = re.compile(r"^(?P<alias>\w+)\s+(?P<color>\S+)\s+(?P<col>-?\d+)\s+"
                      r"(?P<row>-?\d+)(?:\s+(?P<ox>-?\d+))?(?:\s+(?P<oy>-?\d+))?$")


def _parse(spec, default_height):
    """`alias color col row [ox] [oy]` per `;`-separated layer, plus `?height=`.

    Mirrors `face.js`'s `parse`, including its rule that a layer with fewer than four
    tokens is DROPPED rather than defaulted - a half-written layer is not a face."""
    text = str(spec or "").strip()
    height = default_height
    if "?" in text:
        text, _, query = text.partition("?")
        m = re.search(r"height=(\d+)", query)
        if m:
            height = max(8, min(512, int(m.group(1))))
    layers = []
    for part in text.split(";"):
        m = RE_LAYER.match(part.strip())
        if m is None:
            continue
        layers.append({"alias": m.group("alias"),
                       "rgb": _color(m.group("color")),
                       "col": int(m.group("col")), "row": int(m.group("row")),
                       "ox": int(m.group("ox") or 0),
                       "oy": int(m.group("oy") or 0)})
    return layers, height


_NAMED = {"white": (255, 255, 255), "black": (0, 0, 0), "red": (255, 0, 0),
          "green": (0, 128, 0), "blue": (0, 0, 255), "yellow": (255, 255, 0),
          "grey": (128, 128, 128), "gray": (128, 128, 128)}


def _color(text):
    """A CSS color as `(r, g, b)`. Unrecognized -> white, which is face.js's answer
    too: no tint is a better failure than a wrong one."""
    s = str(text or "").strip().lower()
    if s.startswith("#"):
        h = s[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) >= 6:
            try:
                return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
            except ValueError:
                return (255, 255, 255)
    return _NAMED.get(s, (255, 255, 255))
