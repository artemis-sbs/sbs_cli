"""Shared media: unpack a resource pack ONCE, beside the libraries.

Art used to be copied per consuming mission - 27 MB in LegendaryMissions' git, 27 MB
again in every mission that declared the pack. Everything the engine is handed is a path
relative to `data/graphics` (sbs_utils' ImageAtlas ends with `os.path.relpath(file,
graphics_dir)`), so a mission asset already reaches it as `..\\missions\\<mission>\\media
\\...`. A shared copy under `__lib__` is the same shape with a different folder name, and
the engine loads it - proved with `missions/media_probe`.

    __lib__/artemis-sbs.LegendaryMissions.media.v1.4.0.zip     the artifact
    __lib__/media/LegendaryMissions/**                          unpacked ONCE
    __lib__/media/.stamp.json                                   what is unpacked, and from what

THE LAYOUT RULE. A pack's zip already carries its own namespace folder at the root
(`LegendaryMissions/`), so unpacking is a plain extract into one shared root - no
stripping, no per-pack wrapper - and every media path an addon already writes keeps its
suffix. A zip WITHOUT a single root folder gets wrapped in the pack name instead, so a
malformed pack cannot spill loose files into the shared root.

THE STAMP. Version alone is not enough to decide whether to re-unpack: during development
the art changes while the version stays `v1.4.0_dev`, which is exactly when a stale copy
bites. The stamp records the zip's own size+mtime as well, which costs nothing to read.
"""
import hashlib
import json
import os
import shutil
import zipfile
from pathlib import Path

MEDIA_DIR = "media"          # under __lib__/
STAMP = ".stamp.json"


def _stamp_path(lib_dir):
    return os.path.join(lib_dir, MEDIA_DIR, STAMP)


def _read_stamp(lib_dir):
    try:
        with open(_stamp_path(lib_dir), "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        # A missing or unreadable stamp means "unpack everything" - never a crash. The
        # cost of being wrong here is one extra extract.
        return {}


def _write_stamp(lib_dir, stamp):
    path = _stamp_path(lib_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(stamp, f, indent=1, sort_keys=True)


def zip_signature(zip_path):
    """What the stamp compares: the zip's size and mtime, plus a digest of its listing.

    Not the file bodies - hashing 27 MB of art on every build is a tax nobody would pay,
    and a change to any entry moves its size or CRC in the listing anyway.
    """
    st = os.stat(zip_path)
    h = hashlib.sha1()
    try:
        with zipfile.ZipFile(zip_path) as zf:
            for info in sorted(zf.infolist(), key=lambda i: i.filename):
                h.update(("%s|%d|%d;" % (info.filename, info.file_size, info.CRC)).encode())
    except zipfile.BadZipFile:
        return None
    return {"size": st.st_size, "mtime": int(st.st_mtime), "listing": h.hexdigest()}


def _split_name(zip_file):
    """`artemis-sbs.LegendaryMissions.media.v1.4.0.zip` -> (pack key, version parts).

    The key is LOWERCASED: `__lib__` here holds both `LegendaryMissions` and
    `legendaryMissions` spellings of the same pack, and treating them as two packs
    unpacks the same art twice, each overwriting the other.
    """
    stem = os.path.basename(zip_file)
    if stem.endswith(".zip"):
        stem = stem[:-4]
    parts = stem.split(".")
    version = []
    while parts and (parts[-1].startswith("v") or parts[-1][:1].isdigit()
                     or parts[-1].startswith("_")):
        version.insert(0, parts.pop())
    return (".".join(parts) or stem).lower(), version


def pack_name(zip_file):
    """The stamp key: the pack, version aside, so re-versioning REPLACES the unpacked
    copy instead of accumulating one per version."""
    return _split_name(zip_file)[0]


def pack_version(zip_file):
    """A sortable version, so `unpack_all` picks the newest of several zips for one pack.

    `v1.4.0` -> ((1, 4, 0), 1) and `v1.4.0_dev` -> ((1, 4, 0), 0): a suffixed build sorts
    BELOW the release it is a candidate for. Appending the suffix to the numbers instead
    made `v1.4.0_dev` beat `v1.4.0`, because a longer tuple wins a prefix comparison -
    and the stale dev pack got unpacked over the real one.
    """
    numbers, suffixed = [], False
    for token in _split_name(zip_file)[1]:
        for chunk in token.lstrip("v").replace("_", ".").split("."):
            if chunk.isdigit():
                numbers.append(int(chunk))
            elif chunk:
                suffixed = True
    return (tuple(numbers), 0 if suffixed else 1)


def _roots(zf):
    return {n.split("/")[0] for n in zf.namelist() if n and not n.startswith("/")}


def unpack_media(zip_path, lib_dir, force=False, quiet=False):
    """Unpack one media pack into `<lib_dir>/media/`, if the stamp says it is stale.

    Returns True when files were written. Idempotent, and safe to interrupt: the extract
    lands in a temp folder and only then replaces the live one.
    """
    if not os.path.exists(zip_path):
        print("ERROR: no such media pack: %s" % zip_path)
        return False
    key = pack_name(zip_path)
    sig = zip_signature(zip_path)
    if sig is None:
        print("ERROR: not a readable zip: %s" % zip_path)
        return False

    stamp = _read_stamp(lib_dir)
    media_root = os.path.join(lib_dir, MEDIA_DIR)
    have = stamp.get(key)
    if have == sig and not force:
        if not quiet:
            print("media up to date: %s" % key)
        return False

    with zipfile.ZipFile(zip_path) as zf:
        roots = _roots(zf)
        # One root folder is the pack's namespace - extract as-is. Anything else gets
        # wrapped in the pack name so loose files cannot land in the shared root.
        single = len(roots) == 1 and not any(n.rstrip("/") in roots for n in zf.namelist()
                                             if "/" not in n.rstrip("/"))
        target_name = None if single else key
        dest = media_root if single else os.path.join(media_root, key)
        tmp = os.path.join(media_root, ".tmp-" + key)
        if os.path.exists(tmp):
            shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp, exist_ok=True)
        zf.extractall(tmp)

    # Replace only what this pack owns: its own root folder(s), not the whole shared dir.
    owned = sorted(roots) if single else [key]
    for name in owned:
        live = os.path.join(dest if single else media_root, name) if single \
            else os.path.join(media_root, key)
        if os.path.exists(live):
            shutil.rmtree(live, ignore_errors=True)
    os.makedirs(dest, exist_ok=True)
    for name in os.listdir(tmp):
        shutil.move(os.path.join(tmp, name), os.path.join(dest, name))
    shutil.rmtree(tmp, ignore_errors=True)

    stamp[key] = sig
    _write_stamp(lib_dir, stamp)
    where = "/".join(sorted(roots)) if single else key
    print("media unpacked: %s -> %s/%s%s" % (key, MEDIA_DIR, where,
                                             "" if single else "  (wrapped: no single root)"))
    return True


def unpack_all(lib_dir, force=False, quiet=False):
    """Unpack every media pack sitting in `__lib__`. Called after a build or a fetch, so
    a working tree and a downloaded dependency end up in the same layout."""
    if not os.path.isdir(lib_dir):
        return 0
    # `__lib__` accumulates every version ever built or fetched. Unpacking all of them
    # means the same art is written N times and the stamp flips on every run - so pick
    # ONE zip per pack: the highest version, and on a tie the most recently written.
    newest = {}
    for f in sorted(os.listdir(lib_dir)):
        if not (f.lower().endswith(".zip") and ".media." in f.lower()):
            continue
        path = os.path.join(lib_dir, f)
        key = pack_name(path)
        rank = (pack_version(path), os.path.getmtime(path))
        if key not in newest or rank > newest[key][0]:
            newest[key] = (rank, path)
    n = 0
    for _rank, path in sorted(newest.values(), key=lambda x: x[1]):
        n += unpack_media(path, lib_dir, force=force, quiet=quiet)
    return n
