#!/usr/bin/env python3
"""Generate the desktop app icons (plain RGBA PNGs, deterministic).

Usage: python3 scripts/gen-desktop-icons.py
Writes 32x32.png and 128x128.png under apps/desktop/src-tauri/icons/.
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


def write_png(path: Path, size: int) -> None:
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
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + payload)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (32, 128):
        write_png(OUT / f"{size}x{size}.png", size)
    print(f"icons: wrote 32x32.png, 128x128.png under {OUT}")


if __name__ == "__main__":
    main()
