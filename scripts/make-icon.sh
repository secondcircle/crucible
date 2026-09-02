#!/bin/bash
# Regenerates the app's icon art from build/icon.svg: icon.icns for the Mac
# bundle, icon.ico for the Windows shortcut, icon.png for the Linux launcher
# and the window on both.
#
# qlmanage (macOS's own SVG renderer) draws the gradients correctly but bakes
# a white background, so the rounded plate is masked back out with ImageMagick
# before sips/iconutil build the icns. Run after editing icon.svg; all three
# files are committed, so packaging never needs this script.
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

qlmanage -t -s 1024 -o "$work" build/icon.svg >/dev/null

# The mask mirrors the plate in icon.svg: rect 100,100 824x824 rx=185.
magick -size 1024x1024 xc:none -fill white \
  -draw "roundrectangle 100,100,923,923,185,185" "$work/mask.png"
magick "$work/icon.svg.png" "$work/mask.png" \
  -alpha off -compose CopyOpacity -composite "$work/icon-1024.png"

iconset="$work/icon.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$work/icon-1024.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$work/icon-1024.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$iconset" -o build/icon.icns
echo "wrote build/icon.icns"

# The window and the Linux launcher take a plain png.
sips -z 512 512 "$work/icon-1024.png" --out build/icon.png >/dev/null
echo "wrote build/icon.png"

# The Windows shortcut takes an ico, which nothing on a Mac writes; the sizes
# below are the ones Explorer picks between.
for size in 16 24 32 48 64 128 256; do
  sips -z "$size" "$size" "$work/icon-1024.png" --out "$work/ico-$size.png" >/dev/null
done
node scripts/make-ico.js build/icon.ico \
  "$work/ico-16.png" "$work/ico-24.png" "$work/ico-32.png" "$work/ico-48.png" \
  "$work/ico-64.png" "$work/ico-128.png" "$work/ico-256.png"
