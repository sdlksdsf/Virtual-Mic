#!/usr/bin/env python3
"""Create a Windows .res file containing an application icon.

Usage: mkres.py <icon.ico> <output.res>

The resource compiler that ships with some toolchains is not always available,
so this writes the binary resource format directly (RT_ICON + RT_GROUP_ICON).
"""

import struct
import sys


def res_entry(resource_type, name, payload):
    # RESOURCEHEADER: DataSize, HeaderSize, Type, Name, DataVersion, MemoryFlags,
    # LanguageId, Version, Characteristics
    entry = struct.pack("<II", len(payload), 32)
    if isinstance(resource_type, int):
        entry += struct.pack("<H", 0xFFFF) + struct.pack("<H", resource_type)
    else:
        encoded = resource_type.encode("utf-16-le")
        entry += struct.pack("<H", 0xFFFF) + struct.pack("<H", 0)
        entry += struct.pack("<H", len(encoded) // 2) + encoded
    if isinstance(name, int):
        entry += struct.pack("<H", 0xFFFF) + struct.pack("<H", name)
    else:
        encoded = name.encode("utf-16-le")
        entry += struct.pack("<H", 0xFFFF) + struct.pack("<H", 0)
        entry += struct.pack("<H", len(encoded) // 2) + encoded
    entry += struct.pack("<IHIHI", 0, 0x1030, 0x0409, 0, 0)
    header_size = len(entry)
    entry = entry[:4] + struct.pack("<I", header_size) + entry[8:]
    padding = (-len(payload)) % 4
    return entry + payload + b"\0" * padding


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: mkres.py <icon.ico> <output.res>", file=sys.stderr)
        return 2
    icon_path, output = sys.argv[1:]
    data = open(icon_path, "rb").read()
    reserved, kind, count = struct.unpack("<HHH", data[:6])
    if reserved != 0 or kind != 1 or count == 0:
        print("not an icon file", file=sys.stderr)
        return 1

    images = []
    group = struct.pack("<HHH", 0, 1, count)
    for index in range(count):
        width, height, colours, _, planes, bits, size, offset = struct.unpack(
            "<BBBBHHII", data[6 + 16 * index:22 + 16 * index]
        )
        blob = data[offset:offset + size]
        images.append((index + 1, blob))
        group += struct.pack("<BBBBHHIH", width, height, colours, 0, planes, bits, size, index + 1)

    out = bytearray()
    for icon_id, blob in images:
        out += res_entry(3, icon_id, blob)
    out += res_entry(14, 1, group)

    with open(output, "wb") as handle:
        handle.write(out)
    print(f"resources: {count} icon images -> {output} ({len(out)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
