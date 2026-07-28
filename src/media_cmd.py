"""Shared media: unpack a resource pack ONCE, beside the libraries.

Art used to be copied per consuming mission - 27 MB in LegendaryMissions' git and 27 MB
again in every mission that declared the pack. Everything the engine is handed is a path
relative to `data/graphics` (sbs_utils' ImageAtlas ends with `os.path.relpath(file,
graphics_dir)`), so a mission asset already reaches it as `..\missions\<mission>\media
\...`. A shared copy under `__lib__` is the same shape with a different folder name, and
the engine loads it - proved with `missions/media_probe`.

    __lib__/artemis-sbs.LegendaryMissions.media.v1.4.0.zip       the artifact
    __lib__/media/artemis-sbs.LegendaryMissions.media.v1.4.0/**  unpacked ONCE
    __lib__/media/.stamp.json                                    what is unpacked, from what

UNPACKED PER VERSION, named for the zip. Two versions are pinned across the missions here
(seven on v1.4.0, `module_3_bases` on v1.1.0), and a single shared folder would hand one
of them art it did not ask for - a regression on today's per-mission copies. The zip name
is already unique per pack AND version, so it is the folder name; nothing has to invent a
namespace, and a pack's own contents need no wrapper folder of their own.

Addons never write these paths: `sbs_utils.procedural.media_shared` maps a logical path
("casino/terran_back") onto whichever root has it, so the version in the middle stays out
of mission code.

THE STAMP. Version alone cannot decide whether to re-unpack: during development the art
changes while the version stays `v1.4.0_dev`, which is exactly when a stale copy bites.
The stamp records the zip's size, mtime and a digest of its LISTING - not its bodies,
because hashing 27 MB of art on every build is a tax nobody would pay.
"""
import glob
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
    """What the stamp compares: a digest of the zip's LISTING - every entry's name, size
    and CRC.

    Not the file bodies: hashing 27 MB of art on every build is a tax nobody would pay,
    and any change to any entry moves its size or CRC anyway.

    And deliberately NOT the zip's own mtime or size. `sbs.pyz lib` rebuilds the zip on
    every run, which moves both even when the art is untouched - keying on them meant a
    27 MB re-extract after every build of an unrelated addon.
    """
    h = hashlib.sha1()
    try:
        with zipfile.ZipFile(zip_path) as zf:
            for info in sorted(zf.infolist(), key=lambda i: i.filename):
                h.update(("%s|%d|%d;" % (info.filename, info.file_size, info.CRC)).encode())
    except zipfile.BadZipFile:
        return None
    return {"listing": h.hexdigest()}


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
    """The pack, version aside - what two spellings of the same pack agree on."""
    return _split_name(zip_file)[0]


def unpack_dir_name(zip_file):
    """The folder a pack unpacks into: the zip's own name, which is already unique per
    pack AND version. Keyed this way, a mission that pins v1.1.0 keeps v1.1.0 while
    another mission uses v1.4.0."""
    stem = os.path.basename(zip_file)
    return stem[:-4] if stem.endswith(".zip") else stem


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
    """Unpack one media pack into `<lib_dir>/media/<zip name>/`, if the stamp says it is
    stale.

    Returns True when files were written. Idempotent, and safe to interrupt: the extract
    lands in a temp folder and only then replaces the live one.
    """
    if not os.path.exists(zip_path):
        print("ERROR: no such media pack: %s" % zip_path)
        return False
    key = unpack_dir_name(zip_path)
    sig = zip_signature(zip_path)
    if sig is None:
        print("ERROR: not a readable zip: %s" % zip_path)
        return False

    stamp = _read_stamp(lib_dir)
    media_root = os.path.join(lib_dir, MEDIA_DIR)
    if stamp.get(key) == sig and not force:
        if not quiet:
            print("media up to date: %s" % key)
        return False

    dest = os.path.join(media_root, key)
    tmp = os.path.join(media_root, ".tmp-" + key)
    if os.path.exists(tmp):
        shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(tmp)

    # Replace wholesale rather than merge: a file dropped from the pack must disappear
    # from the unpacked copy too.
    if os.path.exists(dest):
        shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(media_root, exist_ok=True)
    shutil.move(tmp, dest)

    stamp[key] = sig
    _write_stamp(lib_dir, stamp)
    print("media unpacked: %s" % key)
    return True


def unpack_all(lib_dir, force=False, quiet=False, pinned=None):
    """Unpack the media packs sitting in `__lib__`, so a working tree and a downloaded
    dependency end up in the same layout.

    EVERY pinned version, not just the newest: missions pin what they pin, and one of
    them getting art it did not ask for is the failure this layout exists to prevent.

    `pinned` (from `pinned_packs`) skips packs no mission declares - `__lib__` keeps every
    version ever built, and extracting 20 MB only for `prune_media` to delete it again is
    work nobody asked for. Omit it to unpack whatever is there.
    """
    if not os.path.isdir(lib_dir):
        return 0
    keep = None if pinned is None else {os.path.basename(p) for p in pinned}
    n = 0
    for f in sorted(os.listdir(lib_dir)):
        if not (f.lower().endswith(".zip") and ".media." in f.lower()):
            continue
        if keep is not None and f not in keep:
            continue
        n += unpack_media(os.path.join(lib_dir, f), lib_dir, force=force, quiet=quiet)
    return n


def pinned_packs(missions_dir):
    """Every media zip the missions under `missions_dir` declare in their `story.json`.

    What `prune_media` keeps. Read rather than assumed: a pack nothing pins is dead
    weight, and a pack one old mission still pins must survive a build for a newer one.
    """
    out = set()
    for story in glob.glob(os.path.join(missions_dir, "*", "story.json")):
        try:
            with open(story, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
        except Exception:
            continue
        # Both spellings count: `resources` asks the ENGINE to copy the pack into the
        # mission, `shared_media` asks nobody to - either way the mission depends on it,
        # so it must be unpacked and must survive pruning.
        declared = list((data.get("resources") or {}).values())
        declared += list(data.get("shared_media") or [])
        for value in declared:
            for v in (value if isinstance(value, list) else [value]):
                v = str(v).strip()
                if v.lower().endswith(".zip"):
                    out.add(v)
    return out


def prune_media(lib_dir, pinned, quiet=False):
    """Drop unpacked packs nothing pins any more - `pinned` is every zip name the
    missions declare. Keeps the shared folder from growing a copy per version ever built
    while staying hands-off about anything still referenced."""
    media_root = os.path.join(lib_dir, MEDIA_DIR)
    if not os.path.isdir(media_root):
        return 0
    keep = {p[:-4] if p.lower().endswith(".zip") else p for p in pinned}
    stamp = _read_stamp(lib_dir)
    n = 0
    for name in sorted(os.listdir(media_root)):
        path = os.path.join(media_root, name)
        if name == STAMP or not os.path.isdir(path) or name.startswith(".tmp-"):
            continue
        if name in keep:
            continue
        shutil.rmtree(path, ignore_errors=True)
        stamp.pop(name, None)
        n += 1
        if not quiet:
            print("media pruned (nothing pins it): %s" % name)
    if n:
        _write_stamp(lib_dir, stamp)
    return n
