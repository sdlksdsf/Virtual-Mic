# Contributing

VoxBridge is small on purpose: one protocol, three native clients, no cloud in
the audio path. Bug reports and focused patches are welcome.

## Before you open a PR

- **Runtime proof beats prose.** Say what you ran, on which OS, and what changed.
  For audio changes include a before/after measurement (THD, noise floor, packet
  loss) — the numbers in the README were produced that way.
- **Do not add a dependency** unless the standard library cannot do the job.
  The Windows service is C++ with no runtime beyond the OS, and the Android app
  uses only AndroidX plus OkHttp.
- **Keep the protocol compatible.** Packet `0x56`, version 1. A change that
  breaks a 1.0.x phone must bump the version and ship a migration path.

## Build locally

```bash
# Windows app (electron shell + native capture service)
cd apps/desktop && npm ci && npm start

# Native service only (MSVC or mingw)
cd apps/desktop/service && cmake -B build && cmake --build build --config Release

# Android (JDK 17 + Android SDK 34)
cd apps/android && gradle assembleDebug

# iOS (macOS + Xcode 15)
cd apps/ios && xcodegen generate && open VoxBridge.xcodeproj

# Website
node scripts/lint.js          # HTML references + JS syntax
cd site-build && node build.js  # static site into site-build/public
```

`node scripts/lint.js` must pass before a PR. It checks every page's local
references and parses every JavaScript file.

## Commit style

`fix(android): …`, `feat(web): …`, `docs: …` — a scope and an imperative
subject. Explain *why* in the body; the diff already shows *what*.

## Reporting bugs

Use the issue templates. For audio, attach **Export diagnostics** from Studio:
it contains device names, negotiated format, buffer depth and loss counters, and
no audio.

Security issues go to security@voxbridge.app — see [SECURITY.md](SECURITY.md).
