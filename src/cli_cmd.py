import os
import sys

import click
from pathlib import Path

zipapp_dir = Path(__file__).resolve().parent.parent
CONTEXT_SETTINGS = dict(help_option_names=['-h', '--help'])

# Where `sbs deps install` puts optional host-side libraries.
SIDECAR = "__pylib__"


def sidecar_dir():
    """The optional-library folder, beside `__lib__`.

    NOT inside `__lib__`: that holds the sbslib/mastlib/media zips the ENGINE
    reads, and `media_cmd.prune_media` actively deletes from it. A pip tree there
    is asking to be pruned."""
    return os.path.join(str(zipapp_dir), SIDECAR)


def _add_sidecar():
    """Put the sidecar on `sys.path` for every command.

    APPENDED, not inserted, and the asymmetry with `compile_cmd` is deliberate:
    that one inserts PyAddons at the FRONT because `ryaml` has to beat the
    bundled pure-Python yaml. This is the opposite case. The sidecar exists for
    things the zipapp does not carry, so a stray `click` or `textual` in there
    must never shadow the one `sbs` ships with and depends on to start.

    Missing is normal and silent - the rule `fs.ryaml_module()` sets out. Most
    installs will never have this folder, and saying so on every command would
    be noise about a thing that was never going to be there.

    This does NOT reach the engine. A mission running inside Artemis is
    bootstrapped by the engine, not by `sbs`, and never sees this path -
    `sbs deps install --engine` targets `PyAddons` for that case."""
    d = sidecar_dir()
    if os.path.isdir(d) and d not in sys.path:
        sys.path.append(d)


_add_sidecar()


@click.group(context_settings=CONTEXT_SETTINGS)
def cli():
    pass
