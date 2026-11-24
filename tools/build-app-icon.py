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

# macOS does not round app icons for you: the desktop icon is the artwork scaled to 824 px with rounded corners on a transparent
# 1024 px canvas (Apple's template). A master that already has transparency is used as it is.
desktop_src = big
has_alpha = subprocess.run(["sips", "-g", "hasAlpha", str(big)], capture_output=True, text=True).stdout.strip().endswith("yes") if shutil.which("sips") else False
if not has_alpha and shutil.which("rsvg-convert"):
    desktop_src = tmp / "desktop-1024.png"
    # clip the artwork to a rounded square with an SVG (rsvg-convert keeps the alpha, which ImageMagick composites did not)
    wrap = tmp / "desktop-wrap.svg"
    wrap.write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs><clipPath id="c"><rect x="100" y="100" width="824" height="824" rx="185" ry="185"/></clipPath></defs>
<image xlink:href="{big.as_posix()}" x="100" y="100" width="824" height="824" clip-path="url(#c)"/></svg>''')
    subprocess.run(["rsvg-convert", "-w", "1024", "-h", "1024", str(wrap), "-o", str(desktop_src)], check=True)
    print("desktop icon: rounded, on a transparent canvas")

desktop = ROOT / "desktop"
if (desktop / "node_modules" / ".bin" / "tauri").exists():
    subprocess.run([str(desktop / "node_modules" / ".bin" / "tauri"), "icon", str(desktop_src)], cwd=desktop, check=True)
    for extra in ("android", "ios"):  # mobile sets we do not ship
        shutil.rmtree(desktop / "src-tauri" / "icons" / extra, ignore_errors=True)
    print("rebuilt desktop/src-tauri/icons")
else:
    print("desktop/node_modules not installed: skipped the desktop icons (cd desktop && npm install)")
