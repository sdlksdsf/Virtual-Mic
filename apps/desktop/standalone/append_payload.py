#!/usr/bin/env python3
"""Append a VoxBridge payload to the setup stub, producing a single-file installer."""

import os
import struct
import sys


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: append_payload.py <setup.exe> <payload.vbx> <output.exe>", file=sys.stderr)
        return 2
    stub, payload, output = sys.argv[1:]
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
        out.write(b"VBXPAY01" + struct.pack("<QQ", stub_size, payload_size))

    print(f"installer: {os.path.getsize(output) / 1048576:.1f} MiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
