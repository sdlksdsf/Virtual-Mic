# Third-party notices

VoxBridge itself is MIT licensed (see `LICENSE`). The following components are
included in or linked into the distributed builds.

## Desktop (Electron)

| Component | Licence | Project |
|---|---|---|
| Electron | MIT | https://github.com/electron/electron |
| Chromium | BSD-3-Clause and others | https://www.chromium.org |
| Node.js | MIT | https://nodejs.org |
| ws | MIT | https://github.com/websockets/ws |
| qrcode | MIT | https://github.com/soldair/node-qrcode |
| electron-builder (build-time) | MIT | https://github.com/electron-userland/electron-builder |

Electron ships its own `LICENSE` and `LICENSES.chromium.html` inside the
installed application; those files are the authoritative notices for Chromium
and its dependencies.

## Fonts

| Family | Licence |
|---|---|
| Instrument Serif | SIL Open Font License 1.1 |
| Inter Tight | SIL Open Font License 1.1 |
| JetBrains Mono | SIL Open Font License 1.1 |

## Android

| Component | Licence |
|---|---|
| Kotlin, kotlinx.coroutines | Apache-2.0 |
| AndroidX Core, Activity, Lifecycle | Apache-2.0 |
| Jetpack Compose, Material 3 | Apache-2.0 |
| OkHttp, Okio | Apache-2.0 |

## iOS

Only Apple system frameworks (AVFoundation, Accelerate, Network, SwiftUI),
distributed under the Xcode and Apple Developer Program terms.

## VB-CABLE

VB-CABLE is a separate product by VB-Audio Software. It is **not** bundled,
repackaged or redistributed by VoxBridge. The app links to the official
installer and verifies its Authenticode signature before offering to run it.
VB-CABLE is donationware; commercial use requires a licence from VB-Audio.

https://vb-audio.com/Cable/
