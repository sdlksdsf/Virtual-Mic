#!/usr/bin/env python3
"""Embed an icon and a version resource into a Windows executable.

Usage: add_icon.py <exe> <icon.ico> [version]

Uses LIEF (pip install lief). The executable is rewritten in place.
"""

import struct
import sys


def icon_tree(icon_path):
    import lief

    data = open(icon_path, "rb").read()
    reserved, kind, count = struct.unpack("<HHH", data[:6])
    if reserved != 0 or kind != 1 or count == 0:
        raise SystemExit("not an icon file")

    root = lief.PE.ResourceDirectory()
    root.id = 0
    icons = lief.PE.ResourceDirectory()
    icons.id = 3
    groups = lief.PE.ResourceDirectory()
    groups.id = 14
    group = bytearray(struct.pack("<HHH", 0, 1, count))

    for index in range(count):
        width, height, colours, _, planes, bits, size, offset = struct.unpack(
            "<BBBBHHII", data[6 + 16 * index:22 + 16 * index]
        )
        blob = data[offset:offset + size]
        name = lief.PE.ResourceDirectory()
        name.id = index + 1
        name.add_child(lief.PE.ResourceData(list(blob)))
        icons.add_child(name)
        group += struct.pack("<BBBBHHIH", width, height, colours, 0, planes, bits, size, index + 1)

    name = lief.PE.ResourceDirectory()
    name.id = 1
    name.add_child(lief.PE.ResourceData(list(bytes(group))))
    groups.add_child(name)
    root.add_child(icons)
    root.add_child(groups)
    return root


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: add_icon.py <exe> <icon.ico>", file=sys.stderr)
        return 2
    import lief

    executable, icon = sys.argv[1], sys.argv[2]
    binary = lief.PE.parse(executable)
    if not binary:
        raise SystemExit(f"could not parse {executable}")
    binary.set_resources(icon_tree(icon))
    binary.write(executable)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
