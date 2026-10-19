# Changelog

All notable changes to VoxBridge are documented here. Dates are UTC.

## [1.0.0] — 2026-10-19

First public release.

### Windows
- Native Windows 10/11 desktop app (installer, x64).
- Wi-Fi and USB audio transport with automatic PC discovery.
- Low-latency capture pipeline (AudioWorklet, 20 ms packets, adaptive jitter buffer).
- Noise suppression, auto gain, presence EQ, warmth, compressor and a true-peak limiter.
- Volume boost up to +24 dB with soft clipping protection.
- Virtual microphone detection and one-click setup (VB-CABLE, verified download).
- Live input verification: record three seconds from the virtual mic to prove apps can hear it.
- Session recording to 16-bit WAV, monitor output, tray controls, autostart.
- Diagnostic report export.

### Android
- Material 3 app with light, dark and system themes.
- Automatic PC discovery (UDP broadcast + manual address + ADB/USB).
- 48 kHz / 32 kHz / 24 kHz / 16 kHz capture, PCM or ADPCM compression.
- On-device noise suppression, AGC, EQ and limiter.
- Foreground service with quick mute/gain controls and a live notification.
- Pairing codes, remembered hosts and connection history.

### iOS
- SwiftUI app (iOS 16+) with the same protocol and DSP presets.
- Background audio session, local network permission handling and Bonjour hints.

### Website
- New site at / with download hub, feature pages, setup guides, privacy, terms and security.
- Light and dark themes, reduced-motion support, accessible navigation.
- Live download counters backed by Supabase.

### Infrastructure
- Reproducible Windows installer builds in GitHub Actions.
- Android APK release builds and an unsigned iOS IPA for sideloading.
- Supabase schema for release telemetry and feedback.
