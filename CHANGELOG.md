# Changelog

All notable changes to VoxBridge are documented here. Dates are UTC.

## [1.0.1] — 2026-10-20

A patch release with two user-visible fixes. Protocol v1 is unchanged, so a
1.0.1 phone still connects to a 1.0.0 desktop and vice versa.

### Android — the stream survives a locked screen
- A partial wake lock and a Wi-Fi lock are now held for the **whole session**
  instead of being taken inside capture with a four-hour expiry.
- The socket pings every 15 seconds, so a half-open connection is detected in
  seconds rather than never.
- Automatic reconnect with 1 s → 15 s backoff, plus an immediate retry when the
  network callback reports Wi-Fi is back.
- `START_STICKY` restarts resume the last host and code instead of idling.
- A stalled microphone reopens after 600 ms while the session is live.
- New Settings → Background section (keep-alive, battery exemption, vendor
  autostart) and a Live-screen banner when Android may still freeze the app.

### Downloads
- All four artifacts are served from the website's own domain with
  `Content-Disposition: attachment`, the correct MIME type, a real
  `Content-Length` and byte-range support.
- The download page renders a single hero for the detected device, so a phone
  can no longer be handed the Windows installer.
- In-app browsers (Instagram, WhatsApp, Facebook, WebView) are detected and told
  how to open the page in Chrome or Safari, instead of leaving a stuck download.

## [1.0.0] — 2026-10-20, second pass

Echo, noise-floor and self-monitoring fixes, plus sharper site artwork. The
release tag stays 1.0.0 and its assets are rebuilt from this commit; the
protocol is untouched, so existing installs keep working.

### Echo and repeats
- The Windows renderer no longer falls back to the **default speakers** when it
  cannot find a virtual cable. That fallback played the caller's voice into the
  room, the phone microphone picked it straight back up, and the user heard
  themselves repeating. With no cable the service now stays silent and the app
  says so, with a one-click route to install VB-CABLE.
- Remembered or hand-picked playback devices are validated before use: only a
  virtual cable endpoint can receive microphone audio. A stale "Speakers" entry
  from an older install can no longer reopen the loop.
- Duplicate frames are dropped at ingest (same sequence number, or older than
  one that already played), and processed frames are de-duplicated by sequence
  number before they reach the cable, so two windows — or a stale tab — cannot
  write every syllable twice.
- The jitter buffer reacts to starvation immediately (+30 ms, capped at 240 ms)
  instead of waiting two seconds, and packet-loss concealment fades in ~20 ms
  instead of repeating 70 ms of the last frame. Late Wi-Fi packets therefore
  stop sounding like stuttered words.

### Background noise
- A speech-gated noise tracker replaces minimum statistics. The estimate now
  freezes while someone is talking and converges during pauses, which removes
  the 6 dB bias that left a hiss floor under the voice.
- Spectral over-subtraction plus a −30 dB high-frequency floor: measured room
  tone rejection is now 16 dB (was 2.4 dB) with ~1 dB of level lost from the
  voice.
- The gate opens at −40 dBFS instead of −44, and auto gain only adapts while
  speech is present, so the room no longer swells between phrases.
- Same estimator, gate and auto-gain order on Android (`Dsp.kt`).

### Monitoring
- A labelled **Monitor** switch now sits in the Live header: off by default,
  persisted, disabled when no cable is installed, and it turns itself visibly
  on with a lamp. Turning it on explains the headphone requirement.
- Monitoring state stays in sync with the Studio toggle and the Live card.

### Site and docs
- Every app screenshot was recaptured at 2× from the running app, including the
  new Monitor switch, and served as 2400 px WebP (≈95 KB each; was 111–172 KB
  PNG at 1440 px, which looked soft on retina displays).
- The site build fetches `apps/web` from the commit that triggered the
  deployment, so the published site can never lag the repository again.

## [1.0.0 rebuild] — 2026-10-20

Audio, pairing and clarity fixes on top of the 1.0.0 tag. The release assets
were rebuilt from this commit, so a fresh download of 1.0.0 already contains
all of it. The protocol and file layout are unchanged, which is why the
version number stays put.

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
