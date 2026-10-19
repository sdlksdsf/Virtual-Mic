# Building VoxBridge

Everything in this repository builds from source with publicly available
toolchains. The release pipeline in `.github/workflows` is the reference
implementation; this page explains the same steps locally.

## Desktop (Windows 10/11)

Requirements: Node.js 20+, CMake 3.20+, Visual Studio 2022 with the C++ desktop
workload, Windows 10 SDK.

```powershell
# 1. Native capture service
cmake -S apps/desktop/service -B build/service -A x64
cmake --build build/service --config Release

# 2. Stage it where electron-builder looks
New-Item -ItemType Directory -Force apps/desktop/service-bin
Copy-Item build/service/Release/VoxBridgeMic.exe apps/desktop/service-bin/
Copy-Item build/service/Release/voxbridge_coretest.exe apps/desktop/service-bin/

# 3. Portable core self-test (no audio hardware required)
build/service/Release/voxbridge_coretest.exe

# 4. App + installers
cd apps/desktop
npm ci
npm run dist -- --publish never
```

Outputs land in `release/`:

- `VoxBridge-Setup-<version>-x64.exe` — NSIS installer
- `VoxBridge-Portable-<version>-x64.exe` — single executable
- `SHA256SUMS.txt` — written by the workflow

`npm start` runs the app against the local renderer; `npm run dev` enables the
development flag. `npm run lint` syntax-checks every JavaScript file in the
repository and verifies that website asset references resolve.

### Code signing

The workflow builds unsigned by default (`CSC_IDENTITY_AUTO_DISCOVERY=false`).
To sign, provide `CSC_LINK` and `CSC_KEY_PASSWORD` as repository secrets and
drop the environment override.

## Android

Requirements: JDK 17, Android SDK 34, Gradle 8.9+.

```bash
cd apps/android
gradle assembleDebug      # app/build/outputs/apk/debug/
gradle assembleRelease    # signed with the debug key unless a keystore is set
```

A release keystore can be supplied through `VOXBRIDGE_KEYSTORE`,
`VOXBRIDGE_KEYSTORE_PASSWORD`, `VOXBRIDGE_KEY_ALIAS` and
`VOXBRIDGE_KEY_PASSWORD`. Without them the release build is signed with the
debug key so CI can still produce an installable artifact.

## iOS

Requirements: macOS 13+, Xcode 15+, XcodeGen.

```bash
cd apps/ios
xcodegen generate
xcodebuild -project VoxBridge.xcodeproj -scheme VoxBridge \
  -configuration Release -sdk iphoneos \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
```

The CI workflow packages the resulting `.app` into
`VoxBridge-1.0.0-unsigned.ipa` (`Payload/` + zip) and uploads it. Signing and
TestFlight instructions live in [`apps/ios/README.md`](../apps/ios/README.md).

## Website

The site is static. Any file server pointed at `apps/web` works:

```bash
cd apps/web
python3 -m http.server 4173
```

Vercel configuration is in `apps/web/vercel.json` (clean URLs, immutable asset
caching, security headers). The only runtime dependencies are GitHub's release
API and Supabase; both degrade gracefully when unavailable.

## Database

Supabase schema and policies: [`packages/supabase`](../packages/supabase).

## Release checklist

1. Bump `version` in `apps/desktop/package.json`, `apps/android/app/build.gradle.kts`
   and `apps/ios/project.yml`.
2. Update `CHANGELOG.md`.
3. Push a tag and let CI build Windows, Android and iOS artifacts.
4. Attach the artifacts, `SHA256SUMS.txt` and the unsigned IPA to the GitHub release.
5. Confirm the website download links resolve (they follow `releases/latest`).
