"""
Generate 192x192 and 512x512 icons from `static/logo.png`.
Requires: Pillow
Usage:
  pip install Pillow
  python tools/generate_icons.py

This script will write `static/logo-192.png` and `static/logo-512.png`.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'static' / 'logo.png'
OUT192 = ROOT / 'static' / 'logo-192.png'
OUT512 = ROOT / 'static' / 'logo-512.png'

if not SRC.exists():
    print('Source logo not found at', SRC)
    raise SystemExit(1)

img = Image.open(SRC).convert('RGBA')
for size, out in ((192, OUT192), (512, OUT512)):
    resized = img.copy()
    resized.thumbnail((size, size), Image.LANCZOS)
    # Ensure exact size by pasting on transparent background
    canvas = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    w, h = resized.size
    canvas.paste(resized, ((size - w) // 2, (size - h) // 2), resized)
    canvas.save(out)
    print('Wrote', out)
