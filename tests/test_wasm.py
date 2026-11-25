"""The browser build's kernel (Pyodide + SMLib WebAssembly) passes the same core checks as the native one.
Needs node and the packages tools/build-web-local.py installs into .cache/web-local (or NERIKONE_WASM_MODULES)."""
import json
import os
import pathlib
import shutil
import subprocess

import pytest

from conftest import ROOT

NM = pathlib.Path(os.environ.get("NERIKONE_WASM_MODULES") or ROOT / ".cache" / "web-local" / "node_modules")
NODE = shutil.which("node")


@pytest.fixture(scope="module")
def results():
    if not NODE or not (NM / "pyodide").is_dir() or not (NM / "@classcad" / "smlibwasm").is_dir():
        pytest.skip("no Pyodide / smlibwasm packages (run tools/build-web-local.py once)")
    r = subprocess.run([NODE, "--no-warnings", str(ROOT / "tests" / "js" / "wasm_kernel.mjs"), str(NM)],
                       capture_output=True, text=True, timeout=600, cwd=ROOT)
    assert r.returncode == 0, r.stderr[-2000:]
    return json.loads(r.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("name", ["scad_import", "box", "fillet", "boolean", "pushpull", "sketch_pocket", "refusal", "export_import", "references", "mate", "groups_and_parts", "drawing_and_measure", "import_place", "every_command", "api"])
def test_wasm_kernel(results, name):
    assert results[name] == "ok", results[name]
