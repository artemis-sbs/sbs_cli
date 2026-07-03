"""Shared test bootstrap.

The ``src`` modules use flat absolute imports (``from file_help import ...``),
so ``src`` must be on ``sys.path`` before any of them can be imported. Import
this module first in every test file.
"""
import os
import sys

_SRC = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src"))
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)
