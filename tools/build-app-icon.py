#!/usr/bin/env python3
"""Make every size of the app icon from one master: design/app-icon/app-icon.png (1024 x 1024) or app-icon.svg.

  python3 tools/build-app-icon.py

Writes nerikone/web/app-icon/ (favicon, PWA and Apple touch icons) and, when desktop/node_modules is installed, runs
`tauri icon` to rebuild desktop/src-tauri/icons (.icns, .ico and the rest).
Needs rsvg-convert (brew install librsvg) for an SVG master, and sips (macOS) or ImageMagick to resize a PNG.
"""
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "design" / "app-icon"
OUT = ROOT / "nerikone" / "web" / "app-icon"
master_png = SRC / "app-icon.png"
master_svg = SRC / "app-icon.svg"
if not master_png.exists() and not master_svg.exists():
    sys.exit(f"put app-icon.svg or app-icon.png (1024 x 1024) in {SRC}")

OUT.mkdir(parents=True, exist_ok=True)
tmp = ROOT / ".cache" / "app-icon"
tmp.mkdir(parents=True, exist_ok=True)
big = tmp / "master-1024.png"
if master_png.exists():
    shutil.copy2(master_png, big)
else:
    if not shutil.which("rsvg-convert"):
        sys.exit("rsvg-convert is needed for an SVG master (brew install librsvg)")
    subprocess.run(["rsvg-convert", "-w", "1024", "-h", "1024", str(master_svg), "-o", str(big)], check=True)


def resize(size, dest):
    if shutil.which("sips"):
        subprocess.run(["sips", "-z", str(size), str(size), str(big), "--out", str(dest)], check=True, stdout=subprocess.DEVNULL)
    elif shutil.which("magick"):
        subprocess.run(["magick", str(big), "-resize", f"{size}x{size}", str(dest)], check=True)
    else:
        sys.exit("need sips (macOS) or ImageMagick to resize")


for name, size in (("favicon-32.png", 32), ("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
    resize(size, OUT / name)
print("wrote", ", ".join(sorted(p.name for p in OUT.iterdir())))

desktop = ROOT / "desktop"
if (desktop / "node_modules" / ".bin" / "tauri").exists():
    subprocess.run([str(desktop / "node_modules" / ".bin" / "tauri"), "icon", str(big)], cwd=desktop, check=True)
    for extra in ("android", "ios"):  # mobile sets we do not ship
        shutil.rmtree(desktop / "src-tauri" / "icons" / extra, ignore_errors=True)
    print("rebuilt desktop/src-tauri/icons")
else:
    print("desktop/node_modules not installed: skipped the desktop icons (cd desktop && npm install)")
