#!/usr/bin/env python3
"""Build the VoxBridge payload archive and attach it to Setup.exe.

Archive layout (little endian):

    char[4]  "VBXP"
    uint32   entry count
    entries:
        uint16  path length in bytes (UTF-8, forward slashes)
        char[]  path
        uint64  uncompressed size
        uint64  compressed size
    concatenated zlib streams

The result is appended to the setup executable, followed by a footer:

    char[8]  "VBXPAY1\\0"
    uint64   payload offset
    uint64   payload size
"""

import os
import struct
import sys
import zlib

FOOTER_MAGIC = b"VBXPAY1\x00"


def build_payload(root: str, output: str) -> None:
    entries = []
    for base, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            relative = os.path.relpath(full, root).replace(os.sep, "/")
            if relative.startswith(".."):
                raise SystemExit(f"refusing to package {relative}")
            with open(full, "rb") as handle:
                data = handle.read()
            entries.append((relative, data, zlib.compress(data, 9)))

    header = bytearray(b"VBXP")
    header += struct.pack("<I", len(entries))
    for relative, data, compressed in entries:
        encoded = relative.encode("utf-8")
        if len(encoded) > 65535:
            raise SystemExit(f"path too long: {relative}")
        header += struct.pack("<H", len(encoded))
        header += encoded
        header += struct.pack("<QQ", len(data), len(compressed))

    with open(output, "wb") as handle:
        handle.write(header)
        for _, _, compressed in entries:
            handle.write(compressed)

    raw = sum(len(data) for _, data, _ in entries)
    print(f"payload: {len(entries)} files, {raw / 1048576:.1f} MiB -> {os.path.getsize(output) / 1048576:.1f} MiB")


def attach(stub: str, payload: str, output: str) -> None:
    stub_size = os.path.getsize(stub)
    payload_size = os.path.getsize(payload)
    with open(output, "wb") as out:
        with open(stub, "rb") as handle:
            while True:
                chunk = handle.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
        with open(payload, "rb") as handle:
            while True:
                chunk = handle.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
        out.write(FOOTER_MAGIC + struct.pack("<QQ", stub_size, payload_size))
    print(f"installer: {os.path.getsize(output) / 1048576:.1f} MiB")


def main() -> int:
    if len(sys.argv) == 3:
        build_payload(sys.argv[1], sys.argv[2])
        return 0
    if len(sys.argv) == 5 and sys.argv[1] == "attach":
        attach(sys.argv[2], sys.argv[3], sys.argv[4])
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
