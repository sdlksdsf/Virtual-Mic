# VoxBridge

**Your phone, now your best microphone.**

VoxBridge turns an Android phone, iPhone, or tablet into a studio-clean microphone for Windows 10 and 11. It ships a native Windows capture service, native mobile apps, a real installer, and this repository holds the entire stack: desktop app, mobile apps, protocol, DSP, website and database.

- **Website:** https://voxbridge.vercel.app
- **Downloads:** https://voxbridge.vercel.app/download
- **Docs:** [`docs/`](docs)
- **Protocol:** [`docs/PROTOCOL.md`](docs/PROTOCOL.md)

---

## What it does

1. Install VoxBridge for Windows and open it.
2. Install VoxBridge on your phone and put both devices on the same Wi-Fi network (or use USB/ADB).
3. The phone is discovered automatically. Tap connect, enter the 4-digit pairing code if asked.
4. VoxBridge routes your voice into a virtual microphone that Zoom, Teams, Discord, OBS, Steam, Valorant and every other Windows app already knows how to use.

## Why it is different

- **No kernel driver to break your PC.** VoxBridge detects the virtual audio device you already trust (VB-CABLE, VoiceMeeter, Virtual Audio Cable, or Stereo Mix), configures it, and verifies it with a real recording test. If nothing is installed, one click fetches the official VB-CABLE installer and checks its Authenticode signature before running it.
- **Honest latency engineering.** 20 ms PCM/ADPCM frames over a WebSocket, an adaptive jitter buffer, an AudioWorklet DSP chain and a native WASAPI renderer. Typical LAN round trip plus rendering stays under 60 ms.
- **No cloud audio.** Audio never leaves your network. Analytics are anonymous and covered in the [privacy policy](apps/web/privacy.html).

## Features

| | |
|---|---|
| Connection | Auto-discovery, manual IP, USB via `adb reverse`, pairing codes, remembered hosts |
| Audio | 48/32/24/16 kHz, PCM16 or IMA-ADPCM, adaptive jitter buffer, packet-loss concealment |
| Cleaning | Spectral noise suppression, noise gate, auto gain, high-pass, presence EQ, warmth EQ, compressor, true-peak limiter |
| Output | +24 dB boost with soft clip protection, monitor passthrough, 16-bit WAV session recording |
| System | Native Windows service, virtual mic detection and verification, device picker, diagnostics, tray, autostart |
| Mobile | Foreground service, quick actions, live meters, quality stats, light/dark themes |

## Repository map

```
apps/desktop        Electron desktop app (Windows installer target) + native capture service in C++
apps/android        Native Android app (Kotlin, Jetpack Compose, foreground service)
apps/ios            Native iOS app (SwiftUI, URLSession WebSocket, Accelerate DSP)
apps/web            Static marketing site + download hub (Vercel)
packages/protocol   Wire protocol notes and golden vectors
packages/supabase   Database schema, RLS policies and edge functions
docs                Architecture, protocol, privacy, build and release documentation
```

## Build it yourself

```bash
# Desktop app (Windows installer)
cd apps/desktop && npm install && npm run dist

# Native Windows capture service (must be built on Windows with MSVC)
cmake -S apps/desktop/service -B build/service -A x64
cmake --build build/service --config Release

# Android
cd apps/android && gradle assembleDebug

# iOS (macOS + Xcode)
cd apps/ios && xcodegen generate && xcodebuild -scheme VoxBridge -sdk iphoneos -configuration Release
```

Full instructions, including how the release pipeline works, are in [`docs/BUILD.md`](docs/BUILD.md).

## Security model

- Pairing codes are required on a per-session basis; sessions can be pinned to a device ID.
- The desktop only listens on the local network. There is no inbound internet port and no relay server.
- Virtual mic setup downloads only from `download.vb-audio.com`, pins the expected publisher and verifies the Authenticode signature before execution.
- Report a vulnerability through the process in [`SECURITY.md`](SECURITY.md). Please do not open a public issue for security problems.

## License

Code is released under the MIT License. VoxBridge is an independent project and is not affiliated with VB-Audio, VoiceMeeter, WO Mic or Microsoft.
