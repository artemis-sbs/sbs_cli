"""Test package bootstrap.

Runs before any test module in this package is imported. The ``src`` modules
use flat absolute imports (``from file_help import ...``), so ``src`` must be on
``sys.path``. Doing it here (rather than a module each test imports) lets
discovery run from the folder root (``-s .``, like sbs_utils) so the tests nest
under the ``sbs_cli`` workspace folder in Test Explorer.
"""
import os
import sys

_SRC = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src"))
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)
