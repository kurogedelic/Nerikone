"""Shared helpers for the Nerikone test suite. Run with:  .venv/bin/python -m pytest -q"""
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "nerikone"))

import kernel as K  # noqa: E402


def build(*steps):
    """A document after running (command, params) steps; any failure fails the test."""
    d = K.Document()
    for cmd, params in steps:
        d.execute(cmd, params)
    return d


def info(doc, name):
    return K.body_info(doc.bodies[name])


def bbox(doc, name, nd=6):
    lo, hi = info(doc, name)["bbox"]
    return [[round(x, nd) + 0.0 for x in lo], [round(x, nd) + 0.0 for x in hi]]


@pytest.fixture
def doc():
    return K.Document()


@pytest.fixture
def cube():
    """A 2 x 2 x 2 box centred on the origin (volume 8, faces at +-1)."""
    return build(("body.box", {}))
