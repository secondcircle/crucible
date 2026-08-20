#!/bin/bash
# Regenerates build/icon.icns from build/icon.svg.
#
# qlmanage (macOS's own SVG renderer) draws the gradients correctly but bakes
# a white background, so the rounded plate is masked back out with ImageMagick
# before sips/iconutil build the icns. Run after editing icon.svg; the icns is
# committed, so packaging never needs this script.
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
