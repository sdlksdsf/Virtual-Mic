#!/usr/bin/env bash
# Build the Windows installer and portable build on Linux or macOS.
#
# Requirements:
#   - Zig 0.13+ (https://ziglang.org) for the native launcher/installer
#   - Python 3
#   - Node.js and npm (to fetch the Windows Node runtime)
#   - A cross-compiled service binary: apps/desktop/service-bin/VoxBridgeMic.exe
#
# Usage:
#   ./build-windows.sh
#   ZIG=/path/to/zig SERVICE_EXE=/path/to/VoxBridgeMic.exe ./build-windows.sh
#
# Artifacts are written to apps/desktop/standalone/dist.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$DESKTOP/../.." && pwd)"
DIST="$HERE/dist"
BUILD="$HERE/.build"
STAGE="$BUILD/payload"
CACHE="$HERE/.cache"
ZIG="${ZIG:-$(command -v zig || true)}"
SERVICE_EXE="${SERVICE_EXE:-$DESKTOP/service-bin/VoxBridgeMic.exe}"
NODE_EXE="${NODE_EXE:-$CACHE/node.exe}"
NODE_VERSION="${NODE_VERSION:-26.12.0}"
ICON="$DESKTOP/build/icon.ico"

if [ -z "$ZIG" ] || ! "$ZIG" version >/dev/null 2>&1; then
  echo "error: Zig was not found. Install it or set ZIG=/path/to/zig." >&2
  exit 1
fi
if [ ! -f "$SERVICE_EXE" ]; then
  echo "error: $SERVICE_EXE is missing." >&2
  echo "Build apps/desktop/service with the Windows cross toolchain first." >&2
  exit 1
fi
if [ ! -f "$ICON" ]; then
  echo "error: $ICON is missing." >&2
  exit 1
fi

mkdir -p "$BUILD/obj" "$CACHE" "$DIST"

if [ ! -f "$NODE_EXE" ]; then
  echo "==> Fetching the Windows Node runtime ($NODE_VERSION)"
  ( cd "$CACHE" && npm pack "node-win-x64@$NODE_VERSION" --silent >/dev/null )
  tarball=$(ls "$CACHE"/node-win-x64-*.tgz | head -1)
  tar -xzf "$tarball" -C "$CACHE"
  cp "$CACHE/package/bin/node.exe" "$NODE_EXE"
fi

if [ ! -d "$DESKTOP/node_modules/ws" ]; then
  echo "==> Installing the WebSocket dependency"
  ( cd "$DESKTOP" && npm install --omit=dev --ignore-scripts --no-audit --no-fund )
fi

echo "==> Compiling Windows launcher, uninstaller and setup"
"$ZIG" cc -target x86_64-windows-gnu -O2 -I"$HERE/third_party/miniz" \
  -c "$HERE/third_party/miniz/miniz.c" -o "$BUILD/obj/miniz.o"
"$ZIG" cc -target x86_64-windows-gnu -O2 -I"$HERE/third_party/miniz" \
  -c "$HERE/third_party/miniz/miniz_tdef.c" -o "$BUILD/obj/miniz_tdef.o"
"$ZIG" cc -target x86_64-windows-gnu -O2 -I"$HERE/third_party/miniz" \
  -c "$HERE/third_party/miniz/miniz_tinfl.c" -o "$BUILD/obj/miniz_tinfl.o"
"$ZIG" cc -target x86_64-windows-gnu -O2 -I"$HERE/third_party/miniz" \
  -c "$HERE/third_party/miniz/miniz_zip.c" -o "$BUILD/obj/miniz_zip.o"

"$ZIG" c++ -target x86_64-windows-gnu -O2 -municode -Wl,--subsystem,windows \
  "$HERE/win/launcher.cpp" -o "$BUILD/VoxBridge.exe" \
  -lole32 -lshell32 -luser32 -lws2_32
"$ZIG" c++ -target x86_64-windows-gnu -O2 -municode -Wl,--subsystem,windows \
  "$HERE/win/uninstall.cpp" -o "$BUILD/VoxBridge-Uninstall.exe" \
  -lole32 -lshell32 -luser32 -ladvapi32
"$ZIG" c++ -target x86_64-windows-gnu -O2 -municode -Wl,--subsystem,windows \
  -I"$HERE/third_party/miniz" "$HERE/win/setup.cpp" \
  "$BUILD/obj/miniz.o" "$BUILD/obj/miniz_tdef.o" "$BUILD/obj/miniz_tinfl.o" "$BUILD/obj/miniz_zip.o" \
  -o "$BUILD/Setup.exe" \
  -lole32 -lshell32 -luser32 -ladvapi32 -lcomctl32 -luuid -lgdi32

echo "==> Adding icons and version information"
BRAND_DIR="$BUILD/brandtools"
if ! node -e "require('resedit')" >/dev/null 2>&1; then
  mkdir -p "$BRAND_DIR"
  ( cd "$BRAND_DIR" && npm init -y >/dev/null 2>&1 && npm install --no-save --no-audit --no-fund resedit pe-library >/dev/null 2>&1 ) || true
  export NODE_PATH="$BRAND_DIR/node_modules${NODE_PATH:+:$NODE_PATH}"
fi
if node -e "require('resedit')" >/dev/null 2>&1; then
  node "$HERE/brand-pe.js" "$BUILD/Setup.exe" "$ICON" "VoxBridge Setup" "$BUILD/Setup.exe"
  node "$HERE/brand-pe.js" "$BUILD/VoxBridge.exe" "$ICON" "VoxBridge" "$BUILD/VoxBridge.exe"
  node "$HERE/brand-pe.js" "$BUILD/VoxBridge-Uninstall.exe" "$ICON" "VoxBridge Uninstaller" "$BUILD/VoxBridge-Uninstall.exe"
else
  echo "resedit is unavailable; keeping the toolchain icons" >&2
fi

echo "==> Staging application files"
rm -rf "$STAGE"
mkdir -p "$STAGE/app/standalone" "$STAGE/app/src/main" "$STAGE/app/node_modules" "$STAGE/service" "$STAGE/licenses"

cp "$BUILD/VoxBridge.exe" "$BUILD/VoxBridge-Uninstall.exe" "$STAGE/"
cp "$NODE_EXE" "$STAGE/node.exe"
cp "$ICON" "$STAGE/voxbridge.ico"
cp "$HERE/server.js" "$STAGE/app/standalone/"
cp "$DESKTOP"/src/main/store.js "$STAGE/app/src/main/"
cp "$DESKTOP"/src/main/server.js "$STAGE/app/src/main/"
cp "$DESKTOP"/src/main/service.js "$STAGE/app/src/main/"
cp "$DESKTOP"/src/main/recorder.js "$STAGE/app/src/main/"
cp -R "$DESKTOP/src/renderer" "$STAGE/app/src/"
cp -R "$DESKTOP/node_modules/ws" "$STAGE/app/node_modules/"
cp "$SERVICE_EXE" "$STAGE/service/VoxBridgeMic.exe"
cp "$ROOT/LICENSE" "$STAGE/licenses/LICENSE"
cp "$ROOT/THIRD_PARTY_NOTICES.md" "$STAGE/licenses/THIRD_PARTY_NOTICES.md" 2>/dev/null || true
cp "$HERE/third_party/miniz/LICENSE" "$STAGE/licenses/miniz-LICENSE.txt"

cat > "$STAGE/README.txt" <<'TEXT'
VoxBridge 1.0.0 for Windows
===========================

VoxBridge turns your phone into a microphone for Windows. Audio travels
directly over your local network; nothing is uploaded to a server.

Quick start
  1. Start VoxBridge (Start menu or desktop shortcut).
  2. Install VoxBridge on your phone and open it.
  3. Keep both devices on the same Wi-Fi. If the phone asks for a code, type
     the four digits shown in the VoxBridge window.
  4. In Zoom, Teams, Discord or OBS choose "CABLE Output (VB-Audio Virtual
     Cable)" as the microphone.

A virtual audio cable is required before other apps can see VoxBridge as a
microphone. Open Studio in the app and choose "Set up virtual mic"; VoxBridge
downloads the official VB-CABLE installer, verifies its signature and asks
Windows for permission once.

Uninstall
  Windows Settings > Apps > VoxBridge > Uninstall, or run
  VoxBridge-Uninstall.exe from the install folder.

License: MIT. Third-party notices are in licenses/.
TEXT

echo "==> Building payload"
python3 "$HERE/make_payload.py" "$STAGE" "$BUILD/payload.vbx"

echo "==> Creating single-file installer"
python3 "$HERE/make_payload.py" attach "$BUILD/Setup.exe" "$BUILD/payload.vbx" \
  "$DIST/VoxBridge-Setup-1.0.0-x64.exe"

echo "==> Creating portable build"
rm -rf "$BUILD/portable"
mkdir -p "$BUILD/portable"
cp -R "$STAGE" "$BUILD/portable/VoxBridge"
rm -f "$BUILD/portable/VoxBridge/VoxBridge-Uninstall.exe"
( cd "$BUILD/portable" && zip -q -9 -r "$DIST/VoxBridge-1.0.0-win64-portable.zip" VoxBridge )

( cd "$DIST" && sha256sum "VoxBridge-Setup-1.0.0-x64.exe" "VoxBridge-1.0.0-win64-portable.zip" > SHA256SUMS.txt )
ls -lh "$DIST"
