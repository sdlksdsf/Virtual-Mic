# Security policy

## Supported versions

Security fixes land in the latest 1.x release. Older builds are not maintained.

## Reporting a vulnerability

Email **security@voxbridge.app** with:

- the version you tested (desktop, Android or iOS),
- operating system and connection mode (Wi-Fi, USB, Bluetooth),
- reproduction steps,
- the impact you believe it has.

Please do **not** open a public issue for an exploitable bug. We aim to
acknowledge within 72 hours, ship a fix in the next release and credit you in
the changelog if you want the credit.

## Scope

In scope:

- the desktop receiver (`apps/desktop`), including the native service,
- the Android app (`apps/android`),
- the iOS app (`apps/ios`),
- the wire protocol in `docs/PROTOCOL.md`,
- the website and its Supabase tables (`apps/web`, `packages/supabase`).

Out of scope:

- vulnerabilities in VB-CABLE, VoiceMeeter, Zoom, Teams, OBS or other third-party software,
- attacks that require an already-compromised PC or phone,
- denial of service against your own local network.

## Design notes

Audio is carried over a WebSocket on the local network. The protocol does not
encrypt audio; confidentiality depends on the link layer (WPA2/WPA3 or the
point-to-point nature of USB tethering). Pairing codes gate new devices. The
desktop binds to the local network only and never exposes an internet-facing
port. See the [security model](apps/web/security.html) for the full threat
table.
