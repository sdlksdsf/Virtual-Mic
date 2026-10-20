# Changelog

All notable changes to VoxBridge are documented here. Dates are UTC.

## [1.0.1] — 2026-10-20

Audio, pairing and clarity fixes on top of 1.0.0. The release assets for 1.0.0
were rebuilt from this commit, so a fresh download already contains all of it.

### Audio
- Rebuilt the voice chain: the denoiser now uses a smoothed periodogram with
  sliding minimum statistics and decision-directed a priori SNR, so consonants
  survive and the "underwater" artefact is gone.
- Boost is applied before the compressor, and a lookahead limiter with a
  −1 dBFS ceiling replaces the old post-compression clamp. THD at default
  settings falls from 1.92 % to 0.01 %; room tone rejection rises by ~6 dB.
- Analysis/synthesis now use square-root Hann windows, which sum to unity at
  50 % overlap. The previous Hann/Hann pair modulated the output at frame rate.
- Android no longer enables the platform noise suppressor, AGC or echo
  canceller on top of the app's own chain, and avoids `VOICE_COMMUNICATION`.

### Pairing
- The phone can scan the QR code shown on the PC (`voxbridge://pair?...`),
  in addition to nearby-PC discovery, manual address and USB.
- The Android scanner runs on a background executor and hops back to the main
  looper for state updates.

### Windows
- On connect the capture service makes the cable the default recording device
  and restores the previous one on exit.
- The app now reports whether that switch actually happened, and offers a
  Sound settings deep link when Windows refuses it.
- Once the cable is detected, the install prompt disappears for good instead of
  reappearing on every launch.

### App and site
- Live view shows an audio-health notice when the browser engine is suspended,
  with a one-click resume.
- Long-form site pages share a centred column; the privacy page no longer
  scrolls sideways on a phone.
- README rewritten with real screenshots, feature tables and measured numbers.

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
