# Osiris branding assets

| File            | Purpose                                                        | Source            |
| --------------- | -------------------------------------------------------------- | ----------------- |
| `osiris.svg`    | Master logo (3D cyan/magenta pyramid). **Canonical.**          | hand-authored     |
| `icon-1024.png` | Raster app icon, 1024×1024 (Linux, base for others)            | exported from SVG |
| `osiris.icns`   | macOS bundle icon                                              | exported from PNG |
| `osiris.ico`    | Windows executable icon                                        | exported from PNG |
| `metadata.json` | _(generated)_ mirror of `src/metadata.ts` for non-TS consumers | build step        |

## Regenerating the raster icons

The SVG is the single source of truth. Regenerate rasters with any of:

```bash
# using librsvg + iconutil (macOS) / icotool (Linux)
rsvg-convert -w 1024 -h 1024 osiris.svg -o icon-1024.png

# macOS .icns
mkdir osiris.iconset
for s in 16 32 128 256 512; do
  rsvg-convert -w $s   -h $s   osiris.svg -o osiris.iconset/icon_${s}x${s}.png
  rsvg-convert -w $((s*2)) -h $((s*2)) osiris.svg -o osiris.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns osiris.iconset

# Windows .ico
icotool -c -o osiris.ico \
  icon-16.png icon-32.png icon-48.png icon-64.png icon-128.png icon-256.png
```

The raster files are intentionally **not** committed as binaries in this scaffold —
CI's `build-desktop` job runs the conversion from `osiris.svg` before packaging.
