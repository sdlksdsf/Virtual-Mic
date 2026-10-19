# VoxBridge for iOS

A native SwiftUI client that speaks the same protocol as the desktop receiver
and the Android app. It captures the microphone with `AVAudioEngine`, runs the
same speech chain (spectral gate, 78 Hz high-pass, presence and warmth shelves,
gate, AGC, compressor, limiter), frames 20 ms PCM16 or IMA-ADPCM packets and
sends them over a WebSocket on your local network.

Nothing is uploaded. There is no account, no analytics SDK and no third-party
binary dependency.

## Requirements

- iOS 16 or newer
- Xcode 15 or newer
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)

## Build

```bash
cd apps/ios
xcodegen generate
open VoxBridge.xcodeproj
```

Select your team under *Signing & Capabilities* and run on a device. The
simulator has no usable microphone input, so it is only useful for layout work.

## Command line build

```bash
xcodegen generate
xcodebuild -project VoxBridge.xcodeproj -scheme VoxBridge \
  -configuration Release -sdk iphoneos \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
```

CI runs exactly this and uploads an unsigned `.ipa` as a workflow artifact.

## Installing the unsigned IPA

Apple requires every installable iOS app to be signed. The artifact is
deliberately unsigned, so you add your own signature with one of:

1. **Xcode** — build to a connected device with your Apple ID as the team.
2. **Sideloadly / AltStore** — drag the `.ipa` in, sign with a free Apple ID.
   Free accounts need a re-sign every 7 days.
3. **TestFlight** — requires a paid Apple Developer account and a signed
   archive; see below.

## TestFlight and App Store

1. Set `DEVELOPMENT_TEAM` in `project.yml` to your team identifier.
2. `xcodebuild -project VoxBridge.xcodeproj -scheme VoxBridge -configuration Release -destination 'generic/platform=iOS' -archivePath build/VoxBridge.xcarchive archive`
3. `xcodebuild -exportArchive -archivePath build/VoxBridge.xcarchive -exportPath build/export -exportOptionsPlist ExportOptions.plist` (use `method: app-store-connect`).
4. Upload with `xcrun altool --upload-app` or Transporter, then invite testers in
   App Store Connect.

The bundle identifier is `app.voxbridge.mic`. Change it in `project.yml` if you
ship your own build.

## Permissions

- **Microphone** (`NSMicrophoneUsageDescription`) — required to stream.
- **Local Network** (`NSLocalNetworkUsageDescription`) — required to reach the
  PC. The first connection shows a system prompt; denying it silently blocks
  both discovery and the socket.
- **Background audio** (`UIBackgroundModes: audio`) — keeps a live session
  running while the screen is locked or you switch apps.

## Layout

```
apps/ios/
  project.yml            XcodeGen definition (targets, plist, icon)
  VoxBridge/
    VoxBridgeApp.swift   entry point and deep-link handling
    ContentView.swift    connect screen and shell
    StudioView.swift     DSP controls
    SettingsView.swift   pairing, diagnostics, about
    MicSession.swift     socket, framing, discovery, state
    AudioEngine.swift    capture, converter, DSP, ADPCM
    Protocol.swift       wire constants, prefs, saved hosts
    Theme.swift          brand tokens and shared views
    Assets.xcassets      icon and accent colour
```

## Troubleshooting

- **"No route to host"** — the phone and PC are on different subnets (guest
  Wi-Fi, VLAN or mobile data). Join the same network or use USB tethering.
- **Pairing rejected** — the desktop rotates the four-digit code every time the
  pairing sheet opens. Read it again.
- **Silent audio** — check the microphone meter in the app. If it is flat, the
  microphone permission was denied; re-enable it in Settings → VoxBridge.
- **Session stops when locked** — background audio is missing from the plist or
  the session was ended by the system after a long idle period.

## Licence

MIT. See the repository `LICENSE`.
