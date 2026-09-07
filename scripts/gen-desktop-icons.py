#!/usr/bin/env python3
"""Generate the desktop app icons (plain RGBA PNGs + ICO/ICNS, deterministic).

Runs inside `cargo xtask build desktop` before the bundler.
Covered by `cargo xtask test desktop` (icons gate).
Usage: python3 scripts/gen-desktop-icons.py
Writes under apps/desktop/src-tauri/icons/:
  32x32.png and 128x128.png (Linux deb PNGs),
  128x128@2x.png (256x256 retina PNG),
  icon.ico (Windows: 16/32/48/64/128/256 PNG-compressed entries),
  icon.icns (macOS: 16/32/64/128/256/512/1024 PNG payloads
    as icp4/icp5/icp6/ic07/ic08/ic09/ic10).

Source art is the repo's own rounded indigo tile, re-rendered procedurally
at each native size (no upscaling, no new branding). Stdlib only, no
timestamps in any output, so re-runs are byte-identical.
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "src-tauri" / "icons"

# Dezoomify indigo, opaque; transparent corners make a rounded tile.
FILL = (63, 81, 181, 255)
CLEAR = (0, 0, 0, 0)


def rounded_rgba(size: int) -> bytes:
    radius = size // 5
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG filter: none
        for x in range(size):
            dx = min(x, size - 1 - x)
            dy = min(y, size - 1 - y)
            if dx < radius and dy < radius:
                corner_x = radius - dx
                corner_y = radius - dy
                if corner_x * corner_x + corner_y * corner_y > radius * radius:
                    rows.extend(CLEAR)
                    continue
            rows.extend(FILL)
    return bytes(rows)


def png_bytes(size: int) -> bytes:
    raw = rounded_rgba(size)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    payload = (
        chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    return b"\x89PNG\r\n\x1a\n" + payload


def write_png(path: Path, size: int) -> None:
    path.write_bytes(png_bytes(size))


def write_ico(path: Path, sizes: list) -> None:
    images = [(size, png_bytes(size)) for size in sizes]
    count = len(images)
    out = bytearray(struct.pack("<HHH", 0, 1, count))
    offset = 6 + 16 * count
    for size, data in images:
        dim = 0 if size >= 256 else size
        out.extend(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    for _, data in images:
        out.extend(data)
    path.write_bytes(bytes(out))


def write_icns(path: Path, entries: list) -> None:
    body = bytearray()
    for ostype, size in entries:
        data = png_bytes(size)
        body.extend(ostype)
        body.extend(struct.pack(">I", 8 + len(data)))
        body.extend(data)
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(body)) + bytes(body))


ICO_SIZES = [16, 32, 48, 64, 128, 256]

# (OSType, pixel size); modern ICNS entries hold PNG payloads.
ICNS_ENTRIES = [
    (b"icp4", 16),
    (b"icp5", 32),
    (b"icp6", 64),
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic09", 512),
    (b"ic10", 1024),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (32, 128):
        write_png(OUT / f"{size}x{size}.png", size)
    write_png(OUT / "128x128@2x.png", 256)
    write_ico(OUT / "icon.ico", ICO_SIZES)
    write_icns(OUT / "icon.icns", ICNS_ENTRIES)
    print(f"icons: wrote 32x32.png, 128x128.png, 128x128@2x.png, icon.ico, icon.icns under {OUT}")


if __name__ == "__main__":
    main()
