#!/usr/bin/env python3
"""Build the browser version (no server): the viewer, plus the kernel running in a Web Worker on WebAssembly.

  python3 tools/build-web-local.py            # writes dist-web/ (static files; serve them from any static host)
  python3 -m http.server -d dist-web 8800

Needs node/npm once, to fetch @classcad/smlibwasm (MIT / Apache-2.0 / OFL-1.1) and pyodide (MPL-2.0); both are copied
next to the page, so it works without a CDN for the kernel.
"""
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "dist-web"
CACHE = ROOT / ".cache" / "web-local"
WEB = ROOT / "nerikone" / "web"
LOCAL = ROOT / "nerikone" / "web-local"

CACHE.mkdir(parents=True, exist_ok=True)
if not (CACHE / "node_modules" / "@classcad" / "smlibwasm").is_dir():
    (CACHE / "package.json").write_text(json.dumps({"name": "web-local-cache", "private": True}))
    subprocess.run(["npm", "install", "--no-audit", "--no-fund", "@classcad/smlibwasm@0.6.2", "pyodide@314.0.8"], cwd=CACHE, check=True)
NM = CACHE / "node_modules"

if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir()
# the viewer
for f in WEB.iterdir():
    if f.name == "index.html":
        continue
    if f.is_dir():
        shutil.copytree(f, OUT / f.name, ignore=shutil.ignore_patterns("tabler", "three"))
    else:
        shutil.copy2(f, OUT / f.name)
html = (WEB / "index.html").read_text(encoding="utf-8")
html = html.replace('<script type="module" src="app.js"></script>', '<script type="module" src="local.js"></script>\n<script type="module" src="app.js"></script>')
html = html.replace("</head>", '<link rel="manifest" href="manifest.webmanifest">\n<meta name="theme-color" content="#17181a">\n</head>')
(OUT / "index.html").write_text(html, encoding="utf-8")
for n in ("worker.js", "local.js", "manifest.webmanifest"):
    shutil.copy2(LOCAL / n, OUT / n)
# Python side
(OUT / "py").mkdir()
for src in (LOCAL / "smlibpy_shim.py", ROOT / "nerikone" / "kernel.py", ROOT / "nerikone" / "vrml.py", ROOT / "nerikone" / "meshio.py", ROOT / "nerikone" / "api.py"):
    shutil.copy2(src, OUT / "py" / src.name)
# the kernel (WebAssembly) and Python (Pyodide), served from the same place
sw = OUT / "vendor" / "smlibwasm"
shutil.copytree(NM / "@classcad" / "smlibwasm", sw, ignore=shutil.ignore_patterns("*.d.ts", "README.md"))
py = OUT / "vendor" / "pyodide"
py.mkdir(parents=True)
for n in ("pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"):
    shutil.copy2(NM / "pyodide" / n, py / n)
# numpy is not in the npm package: fetch the wheel the lock file names (from the Pyodide release CDN), check its hash
import hashlib
import urllib.request
lock = json.loads((NM / "pyodide" / "pyodide-lock.json").read_text())
ver = json.loads((NM / "pyodide" / "package.json").read_text())["version"]
pkg = lock["packages"]["numpy"]
wheel = CACHE / pkg["file_name"]
if not wheel.exists():
    urllib.request.urlretrieve(f"https://cdn.jsdelivr.net/pyodide/v{ver}/full/{pkg['file_name']}", wheel)
if hashlib.sha256(wheel.read_bytes()).hexdigest() != pkg["sha256"]:
    sys.exit("numpy wheel does not match the lock file")
shutil.copy2(wheel, py / wheel.name)
import urllib.error
lic = CACHE / "PYODIDE-LICENSE"
if not lic.exists():
    urllib.request.urlretrieve("https://raw.githubusercontent.com/pyodide/pyodide/main/LICENSE", lic)
shutil.copy2(lic, py / "LICENSE")
# offline cache: the service worker precaches every file, under a name made from a hash of all of them
import hashlib
files = sorted(p.relative_to(OUT).as_posix() for p in OUT.rglob("*") if p.is_file())
h = hashlib.sha256()
for f in files:
    if f != "index.html":  # the page carries the build number itself
        h.update(f.encode())
        h.update((OUT / f).read_bytes())
build = h.hexdigest()[:7]
(OUT / "index.html").write_text((OUT / "index.html").read_text(encoding="utf-8").replace('name="nerikone-build" content="dev"', f'name="nerikone-build" content="{build}"'), encoding="utf-8")
sw = (LOCAL / "sw.js").read_text(encoding="utf-8").replace("__VERSION__", build).replace("__FILES__", json.dumps(["./"] + files))
(OUT / "sw.js").write_text(sw, encoding="utf-8")
size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
print(f"dist-web build {build}: {size / 1e6:.1f} MB, {sum(1 for _ in OUT.rglob('*') if _.is_file())} files")
