// VoxBridge portable audio core.
// Shared by the Windows capture service and the portable self-test binary.
// No third-party dependencies; C++17.
#pragma once

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace vb {

constexpr std::size_t kHeaderBytes = 12;
constexpr std::uint8_t kMagic = 0x56;
constexpr std::uint8_t kVersion = 1;
constexpr std::uint8_t kCodecPcm16 = 0;
constexpr std::uint8_t kCodecAdpcm = 1;

inline std::uint16_t rd16(const std::uint8_t* p) {
  return static_cast<std::uint16_t>(p[0] | (p[1] << 8));
}
inline std::uint32_t rd32(const std::uint8_t* p) {
  return static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8) |
         (static_cast<std::uint32_t>(p[2]) << 16) | (static_cast<std::uint32_t>(p[3]) << 24);
}
inline void wr16(std::uint8_t* p, std::uint16_t v) {
  p[0] = static_cast<std::uint8_t>(v & 0xff);
  p[1] = static_cast<std::uint8_t>((v >> 8) & 0xff);
}
inline void wr32(std::uint8_t* p, std::uint32_t v) {
  p[0] = static_cast<std::uint8_t>(v & 0xff);
  p[1] = static_cast<std::uint8_t>((v >> 8) & 0xff);
  p[2] = static_cast<std::uint8_t>((v >> 16) & 0xff);
  p[3] = static_cast<std::uint8_t>((v >> 24) & 0xff);
}

struct PacketView {
  std::uint8_t codec = kCodecPcm16;
  std::uint8_t flags = 0;
  std::uint16_t seq = 0;
  std::uint32_t ts = 0;
  const std::uint8_t* payload = nullptr;
  std::uint16_t payload_len = 0;
};

inline bool parseHeader(const std::uint8_t* d, std::size_t n, PacketView& out) {
  if (n < kHeaderBytes || d[0] != kMagic) return false;
  const std::uint16_t len = rd16(d + 10);
  if (kHeaderBytes + len != n) return false;
  out.codec = d[2];
  out.flags = d[3];
  out.seq = rd16(d + 4);
  out.ts = rd32(d + 6);
  out.payload = d + kHeaderBytes;
  out.payload_len = len;
  return true;
}

inline std::size_t writeHeader(std::uint8_t* d, std::uint8_t codec, std::uint8_t flags,
                               std::uint16_t seq, std::uint32_t ts, std::uint16_t payloadLen) {
  d[0] = kMagic;
  d[1] = kVersion;
  d[2] = codec;
  d[3] = flags;
  wr16(d + 4, seq);
  wr32(d + 6, ts);
  wr16(d + 10, payloadLen);
  return kHeaderBytes;
}

// ---------------------------------------------------------------------------
// IMA ADPCM (4 bit). Independently decodable blocks: predictor(2), index(1), 0.
// ---------------------------------------------------------------------------
inline const int kIndexTable[16] = {-1, -1, -1, -1, 2, 4, 6, 8,
                                    -1, -1, -1, -1, 2, 4, 6, 8};
inline const int kStepTable[89] = {
    7,     8,     9,     10,    11,    12,    13,    14,    16,    17,    19,
    21,    23,    25,    28,    31,    34,    37,    41,    45,    50,    55,
    60,    66,    73,    80,    88,    97,    107,   118,   130,   143,   157,
    173,   190,   209,   230,   253,   279,   307,   337,   371,   408,   449,
    494,   544,   598,   658,   724,   796,   876,   963,   1060,  1166,  1282,
    1411,  1552,  1707,  1878,  2066,  2272,  2499,  2749,  3024,  3327,  3660,
    4026,  4428,  4871,  5358,  5894,  6484,  7132,  7845,  8630,  9493,  10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767};

inline int clampIndex(int i) { return i < 0 ? 0 : (i > 88 ? 88 : i); }
inline std::int16_t clamp16(int v) {
  return static_cast<std::int16_t>(v < -32768 ? -32768 : (v > 32767 ? 32767 : v));
}

class AdpcmDecoder {
 public:
  void reset(std::int16_t predictor, int index) {
    pred_ = predictor;
    index_ = clampIndex(index);
  }
  std::int16_t decode(std::uint8_t nibble) {
    const int step = kStepTable[index_];
    int diff = step >> 3;
    if (nibble & 4) diff += step;
    if (nibble & 2) diff += step >> 1;
    if (nibble & 1) diff += step >> 2;
    if (nibble & 8)
      pred_ = static_cast<std::int16_t>(pred_ - diff);
    else
      pred_ = static_cast<std::int16_t>(pred_ + diff);
    pred_ = clamp16(pred_);
    index_ = clampIndex(index_ + kIndexTable[nibble & 0x0f]);
    return pred_;
  }

 private:
  std::int16_t pred_ = 0;
  int index_ = 0;
};

class AdpcmEncoder {
 public:
  void reset(std::int16_t predictor) {
    pred_ = predictor;
    index_ = 0;
  }
  std::uint8_t encode(std::int16_t sample) {
    const int step = kStepTable[index_];
    int diff = sample - pred_;
    std::uint8_t code = 0;
    if (diff < 0) {
      code = 8;
      diff = -diff;
    }
    int temp = step;
    if (diff >= temp) {
      code |= 4;
      diff -= temp;
    }
    temp >>= 1;
    if (diff >= temp) {
      code |= 2;
      diff -= temp;
    }
    temp >>= 1;
    if (diff >= temp) code |= 1;

    int pred = pred_;
    int d = step >> 3;
    if (code & 4) d += step;
    if (code & 2) d += step >> 1;
    if (code & 1) d += step >> 2;
    if (code & 8)
      pred -= d;
    else
      pred += d;
    pred_ = clamp16(pred);
    index_ = clampIndex(index_ + kIndexTable[code]);
    return code;
  }

 private:
  std::int16_t pred_ = 0;
  int index_ = 0;
};

inline std::vector<std::int16_t> decodeAdpcm(const std::uint8_t* p, std::size_t n) {
  std::vector<std::int16_t> out;
  if (n < 4) return out;
  AdpcmDecoder dec;
  dec.reset(static_cast<std::int16_t>(rd16(p)), p[2]);
  const std::size_t nibbles = (n - 4) * 2;
  out.reserve(nibbles);
  for (std::size_t i = 0; i < n - 4; ++i) {
    out.push_back(dec.decode(p[4 + i] & 0x0f));
    out.push_back(dec.decode((p[4 + i] >> 4) & 0x0f));
  }
  return out;
}

inline std::vector<std::uint8_t> encodeAdpcm(const std::int16_t* samples, std::size_t count,
                                             std::int16_t predictor) {
  std::vector<std::uint8_t> out;
  out.resize(4 + (count + 1) / 2);
  AdpcmEncoder enc;
  enc.reset(predictor);
  wr16(out.data(), static_cast<std::uint16_t>(predictor));
  out[2] = 0;
  out[3] = 0;
  std::size_t oi = 4;
  for (std::size_t i = 0; i < count; i += 2) {
    const std::uint8_t lo = enc.encode(samples[i]);
    std::uint8_t hi = 0;
    if (i + 1 < count) hi = enc.encode(samples[i + 1]);
    out[oi++] = static_cast<std::uint8_t>(lo | (hi << 4));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Thread-safe PCM ring buffer (mono int16).
// ---------------------------------------------------------------------------
class PcmRing {
 public:
  explicit PcmRing(std::size_t capacity) : buf_(capacity, 0), cap_(capacity) {}

  void push(const std::int16_t* data, std::size_t n) {
    std::lock_guard<std::mutex> lock(m_);
    for (std::size_t i = 0; i < n; ++i) {
      if (size_ == cap_) {
        // Overrun: drop the oldest frame rather than corrupting the clock.
        head_ = (head_ + 1) % cap_;
        --size_;
        ++dropped_;
      }
      buf_[(head_ + size_) % cap_] = data[i];
      ++size_;
    }
    pushed_ += n;
  }

  // Reads up to n samples; missing samples are silent. Returns real sample count.
  std::size_t read(std::int16_t* dst, std::size_t n) {
    std::lock_guard<std::mutex> lock(m_);
    std::size_t real = size_ < n ? size_ : n;
    for (std::size_t i = 0; i < real; ++i) dst[i] = buf_[(head_ + i) % cap_];
    if (real) {
      head_ = (head_ + real) % cap_;
      size_ -= real;
    }
    if (real < n) {
      std::memset(dst + real, 0, (n - real) * sizeof(std::int16_t));
      underruns_ += (n - real);
    }
    return real;
  }

  // Peeks at up to n samples without consuming them.
  std::size_t peek(std::int16_t* dst, std::size_t n) {
    std::lock_guard<std::mutex> lock(m_);
    std::size_t real = size_ < n ? size_ : n;
    for (std::size_t i = 0; i < real; ++i) dst[i] = buf_[(head_ + i) % cap_];
    return real;
  }

  std::size_t available() const {
    std::lock_guard<std::mutex> lock(m_);
    return size_;
  }
  std::size_t capacity() const { return cap_; }
  std::uint64_t underruns() const {
    std::lock_guard<std::mutex> lock(m_);
    return underruns_;
  }
  std::uint64_t dropped() const {
    std::lock_guard<std::mutex> lock(m_);
    return dropped_;
  }
  void clear() {
    std::lock_guard<std::mutex> lock(m_);
    head_ = 0;
    size_ = 0;
  }

 private:
  mutable std::mutex m_;
  std::vector<std::int16_t> buf_;
  std::size_t cap_;
  std::size_t head_ = 0;
  std::size_t size_ = 0;
  std::uint64_t underruns_ = 0;
  std::uint64_t dropped_ = 0;
  std::uint64_t pushed_ = 0;
};

// ---------------------------------------------------------------------------
// Output stage: DC blocker + gain + soft-knee limiter. Always keeps samples
// inside int16 and never lets a loud phone clip the virtual cable input.
// ---------------------------------------------------------------------------
class OutputStage {
 public:
  void setGainDb(float db) {
    db = std::max(-24.0f, std::min(24.0f, db));
    gain_.store(std::pow(10.0f, db / 20.0f));
  }
  float gain() const { return gain_.load(); }

  void process(std::int16_t* samples, std::size_t n) {
    const float g = gain_.load();
    const float k = 0.9995f;
    float peak = 0.0f;
    for (std::size_t i = 0; i < n; ++i) {
      float x = static_cast<float>(samples[i]) / 32768.0f;
      // one-pole DC blocker
      dc_ = x - dcIn_ + k * dc_;
      dcIn_ = x;
      x = dc_ * g;
      // soft clip: linear inside 0.85, polynomial knee to 1.0
      const float a = std::fabs(x);
      if (a > 0.85f) {
        const float over = a - 0.85f;
        const float shaped = 0.85f + 0.15f * (1.0f - std::exp(-over / 0.15f));
        x = x < 0 ? -shaped : shaped;
      }
      if (a > peak) peak = a;
      samples[i] = clamp16(static_cast<int>(x * 32767.0f));
    }
    const float prev = peak_.load();
    if (peak > prev) peak_.store(peak);
  }

  float takePeak() {
    float p = peak_.load();
    peak_.store(0.0f);
    return p;
  }

 private:
  std::atomic<float> gain_{1.0f};
  std::atomic<float> peak_{0.0f};
  float dc_ = 0.0f;
  float dcIn_ = 0.0f;
};

// ---------------------------------------------------------------------------
// WAV writer (16-bit PCM). Header sizes are patched on close.
// ---------------------------------------------------------------------------
class WavWriter {
 public:
  WavWriter() = default;
  ~WavWriter() { close(); }
  WavWriter(const WavWriter&) = delete;
  WavWriter& operator=(const WavWriter&) = delete;

  bool open(const std::string& path, std::uint32_t rate, std::uint16_t channels) {
    close();
    rate_ = rate;
    channels_ = channels;
    f_ = std::fopen(path.c_str(), "wb");
    if (!f_) return false;
    std::uint8_t h[44] = {};
    writeHeader(h, 0);
    std::fwrite(h, 1, sizeof(h), f_);
    dataBytes_ = 0;
    return true;
  }

  void write(const std::int16_t* samples, std::size_t count) {
    if (!f_) return;
    const std::size_t bytes = count * sizeof(std::int16_t);
    std::fwrite(samples, 1, bytes, f_);
    dataBytes_ += bytes;
  }

  bool isOpen() const { return f_ != nullptr; }

  void close() {
    if (!f_) return;
    std::uint8_t h[44] = {};
    writeHeader(h, dataBytes_);
    std::fseek(f_, 0, SEEK_SET);
    std::fwrite(h, 1, sizeof(h), f_);
    std::fclose(f_);
    f_ = nullptr;
    dataBytes_ = 0;
  }

 private:
  void writeHeader(std::uint8_t* h, std::uint32_t dataBytes) const {
    const std::uint32_t byteRate = rate_ * channels_ * 2;
    std::memcpy(h, "RIFF", 4);
    wr32(h + 4, 36 + dataBytes);
    std::memcpy(h + 8, "WAVEfmt ", 8);
    wr32(h + 16, 16);
    wr16(h + 20, 1);
    wr16(h + 22, channels_);
    wr32(h + 24, rate_);
    wr32(h + 28, byteRate);
    wr16(h + 32, static_cast<std::uint16_t>(channels_ * 2));
    wr16(h + 34, 16);
    std::memcpy(h + 36, "data", 4);
    wr32(h + 40, dataBytes);
  }

  std::FILE* f_ = nullptr;
  std::uint32_t rate_ = 48000;
  std::uint16_t channels_ = 1;
  std::uint32_t dataBytes_ = 0;
};

inline std::string jsonEscape(const std::string& in) {
  std::string out;
  out.reserve(in.size() + 8);
  for (unsigned char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

}  // namespace vb
