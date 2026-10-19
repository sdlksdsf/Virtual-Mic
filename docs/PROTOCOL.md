# VoxBridge wire protocol — v1

Status: **stable**. This document is the contract between the mobile senders (Android, iOS) and the Windows desktop receiver, and between the Electron main process and the native capture service.

## 1. Transport

| Path | Transport | Default |
|---|---|---|
| Phone → desktop | WebSocket (RFC 6455) over TCP | `ws://<pc-ipv4>:8720/mic` |
| Desktop discovery | UDP broadcast | port `8721` |
| USB / ADB | WebSocket through `adb reverse tcp:8720 tcp:8720` | `ws://127.0.0.1:8720/mic` |
| Desktop → native service | anonymous pipe (stdin/stdout), length-prefixed binary + JSON lines | — |

TLS is not used on the local network. The stream is protected by a short-lived pairing code and never leaves the LAN. Do not expose port 8720 to the internet.

## 2. Discovery

The desktop broadcasts a UTF-8 JSON datagram every 2 seconds to `255.255.255.255:8721` (and to each interface's broadcast address):

```json
{"voxbridge":1,"name":"DESKTOP-ABC","port":8720,"host":"192.168.1.20","pair":true,"version":"1.0.0"}
```

Phones listen on `8721` while the connect screen is visible, and keep the newest announcement per host for 6 seconds. Broadcast can be blocked by guest Wi-Fi isolation; the manual-address path must always remain available.

## 3. WebSocket session

All text frames are UTF-8 JSON. All binary frames are audio packets (§5).

### 3.1 Hello

The client sends this as the very first frame:

```json
{"t":"hello","v":1,"name":"Pixel 8","device":"android","code":"1234","token":"optional-persistent-token","app":"1.0.0","caps":["pcm16","adpcm","stats"]}
```

The desktop replies either:

```json
{"t":"welcome","v":1,"session":"a1b2c3d4","name":"DESKTOP-ABC","auth":"code","stream":{"rate":48000,"codec":"pcm16","channels":1,"frame_ms":20},"settings":{"mute":false,"gain":1.0},"server":"1.0.0"}
```

or, when the code is wrong or missing:

```json
{"t":"denied","reason":"pairing-code","hint":"Enter the four digit code shown on the PC."}
```

`auth` is `code`, `token` or `open` (the desktop may be configured to accept any device on the same network). After denial the desktop must close with WebSocket code 4401.

### 3.2 Control messages

| Message | Direction | Body |
|---|---|---|
| `ping` | both | `{"t":"ping","id":42,"ts":123456}` |
| `pong` | both | `{"t":"pong","id":42,"ts":123456,"echo":123401}` |
| `config` | desktop → phone | `{"t":"config","stream":{"rate":48000,"codec":"adpcm","frame_ms":20}}` |
| `mute` | both | `{"t":"mute","on":true}` |
| `stats` | desktop → phone | see below |
| `quality` | phone → desktop | `{"t":"quality","rtt":9,"loss":0.0,"sent":1902}` |
| `bye` | both | `{"t":"bye","reason":"user"}` |

Desktop `stats` (sent once per second):

```json
{"t":"stats","rx":1940,"lost":2,"jitter":4,"buffer":80,"rtt":11,"bitrate":394.2,"level":0.31,"peak":0.62,"codec":"pcm16","state":"live"}
```

`buffer` is the current jitter-buffer target in milliseconds; `level` is RMS (0–1); `peak` is the last peak (0–1).

The desktop sends `config` whenever the user changes sample rate or codec. The phone must acknowledge the change by starting the new format on the next packet and resetting `seq` to zero.

## 4. Sample rates and codecs

- `pcm16` — signed little-endian 16-bit mono PCM, up to 960 samples (20 ms at 48 kHz) per packet.
- `adpcm` — IMA ADPCM, 4-bit, independent blocks (§5.2). Each packet carries its own predictor, so a lost packet cannot corrupt later audio.
- Supported rates: 16000, 24000, 32000, 48000 Hz. Default 48000 Hz mono.
- A packet must contain at most 1200 bytes of payload. Senders should use 20 ms frames; 10 ms is allowed.

## 5. Audio packets

### 5.1 Header (12 bytes, little-endian)

```
offset  size  field
0       1     magic 0x56 ('V')
1       1     version (1)
2       1     codec (0 = pcm16, 1 = adpcm)
3       1     flags (bit 0 = silent frame, bit 1 = end-of-stream)
4       2     sequence (wraps at 65535, starts at 0 for every stream/config)
6       4     timestamp in milliseconds, sender monotonic clock
10      2     payload length
12      n     payload
```

The 12-byte header is also used verbatim inside the desktop↔service pipe, prefixed with a 4-byte little-endian length. This keeps a single parser on both sides.

### 5.2 IMA ADPCM block

```
byte 0..1  int16 predictor (initial sample)
byte 2     uint8 step index (0..88)
byte 3     reserved 0
byte 4..   nibbles, low nibble first
```

Decoder state is reset from the header on every packet. The encoder resets its index to the running state at block start and stores the *previous* reconstructed sample as predictor.

## 6. Latency budget

| Stage | Typical |
|---|---|
| Capture + 20 ms frame | 20 ms |
| Wi-Fi (802.11ac, same AP) | 3–12 ms |
| Jitter buffer (adaptive, default 80 ms target on 48 kHz) | 40–80 ms |
| DSP + AudioWorklet | 10–15 ms |
| Native service software buffer + WASAPI | 20–30 ms |
| **End-to-end** | **≈ 55–90 ms** |

The desktop reports its measured buffer depth and RTT in `stats` so the mobile UI can show a real quality value rather than a fake one.

## 7. Pairing and identity

- The desktop generates a new 4-digit code for every launch, and rotates it after a successful pairing if `pair_once` is enabled.
- If the user enables **Remember this device**, the phone sends a random 32-byte token; the desktop stores a SHA-256 hash with the device name and accepts it in future sessions for that device ID.
- Codes and tokens are never logged. Failed attempts are rate-limited to five per minute per address, then the desktop closes the listener for 30 seconds.

## 8. Errors

The desktop closes the socket with an application close code:

| Code | Meaning |
|---|---|
| 4400 | Malformed hello or unsupported version |
| 4401 | Pairing failed |
| 4408 | Session timed out (no packets for 10 s) |
| 4429 | Too many attempts / rate limited |
| 4500 | Internal receiver error |

The phone should surface a plain-language message, never a raw stack trace.

## 9. Golden vectors

`packages/protocol/vectors.json` contains byte-exact packets used by the automated tests. Any change to §5 requires new vectors and a protocol version bump.
