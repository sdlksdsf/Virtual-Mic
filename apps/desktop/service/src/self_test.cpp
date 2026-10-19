// Portable core tests. Built and executed on Linux and Windows CI.
#include "vb_core.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

int gFailures = 0;

void check(bool condition, const char* label) {
  std::printf("%s %s\n", condition ? "PASS" : "FAIL", label);
  if (!condition) ++gFailures;
}

void testHeader() {
  std::uint8_t buffer[64] = {};
  vb::writeHeader(buffer, vb::kCodecAdpcm, 1, 1234, 987654, 8);
  vb::PacketView view;
  check(vb::parseHeader(buffer, 20, view), "header parses with trailing payload");
  check(view.codec == vb::kCodecAdpcm, "codec preserved");
  check(view.seq == 1234, "sequence preserved");
  check(view.ts == 987654, "timestamp preserved");
  check(view.payload_len == 8, "payload length preserved");
  check(!vb::parseHeader(buffer, 10, view), "short header rejected");
  buffer[0] = 0x00;
  check(!vb::parseHeader(buffer, 20, view), "magic enforced");
}

void testGoldenVectors() {
  const std::uint8_t pcmSilence[] = {0x56, 0x01, 0x00, 0x00, 0x00, 0x00,
                                     0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  vb::PacketView view;
  check(vb::parseHeader(pcmSilence, sizeof(pcmSilence), view), "golden pcm16-silence parses");
  check(view.payload_len == 0, "golden silence has no payload");

  const std::uint8_t oneSample[] = {0x56, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                    0x00, 0x00, 0x02, 0x00, 0x34, 0x12};
  check(vb::parseHeader(oneSample, sizeof(oneSample), view), "golden pcm16-one-sample parses");
  check(view.payload_len == 2, "golden one-sample length");
  check(static_cast<std::int16_t>(vb::rd16(view.payload)) == 0x1234, "little-endian sample");
}

void testAdpcm() {
  const std::size_t count = 960;
  std::vector<std::int16_t> input(count);
  for (std::size_t i = 0; i < count; ++i) {
    const double t = static_cast<double>(i) / 48000.0;
    input[i] = static_cast<std::int16_t>(12000.0 * std::sin(2.0 * 3.14159265358979 * 440.0 * t));
  }
  auto encoded = vb::encodeAdpcm(input.data(), input.size(), 0);
  check(encoded.size() == 4 + count / 2, "adpcm packet size is 4 + n/2");
  auto decoded = vb::decodeAdpcm(encoded.data(), encoded.size());
  check(decoded.size() == count, "adpcm decodes every sample");

  double signal = 0.0;
  double noise = 0.0;
  for (std::size_t i = 0; i < count; ++i) {
    const double a = input[i];
    const double b = decoded[i];
    signal += a * a;
    noise += (a - b) * (a - b);
  }
  const double snr = 10.0 * std::log10(signal / (noise > 0 ? noise : 1));
  std::printf("      adpcm snr = %.1f dB\n", snr);
  check(snr > 18.0, "adpcm snr above 18 dB for a 440 Hz tone");

  auto empty = vb::decodeAdpcm(encoded.data(), 2);
  check(empty.empty(), "truncated adpcm block rejected");
}

void testRing() {
  vb::PcmRing ring(10);
  std::int16_t input[8] = {1, 2, 3, 4, 5, 6, 7, 8};
  ring.push(input, 8);
  check(ring.available() == 8, "ring accepts pushes");
  std::int16_t out[4] = {};
  check(ring.read(out, 4) == 4, "ring read returns real samples");
  check(out[0] == 1 && out[3] == 4, "ring preserves order");
  check(ring.available() == 4, "ring tracks availability");

  std::int16_t extra[6] = {9, 10, 11, 12, 13, 14};
  ring.push(extra, 6);
  check(ring.available() == 10, "ring fills to capacity");
  ring.push(extra, 4);
  check(ring.dropped() == 4, "ring drops oldest samples on overrun");

  std::int16_t silence[64] = {};
  const std::size_t real = ring.read(silence, 64);
  check(real == 10, "ring reports underrun count");
  check(silence[10] == 0 && silence[63] == 0, "ring pads with silence");
  check(ring.underruns() == 54, "ring counts missing samples");
}

void testOutputStage() {
  vb::OutputStage stage;
  stage.setGainDb(24.0f);
  std::int16_t samples[256];
  for (std::size_t i = 0; i < 256; ++i) {
    samples[i] = static_cast<std::int16_t>((i % 2) ? 32767 : -32768);
  }
  stage.process(samples, 256);
  bool compressed = true;
  for (std::size_t i = 0; i < 256; ++i) {
    if (std::abs(static_cast<int>(samples[i])) > 32767) compressed = false;
  }
  check(compressed, "limiter keeps int16 range under +24 dB");
  int peakSample = 0;
  for (std::size_t i = 0; i < 256; ++i) {
    peakSample = std::max(peakSample, std::abs(static_cast<int>(samples[i])));
  }
  check(peakSample > 30000, "hot signal still reaches full scale");
  check(stage.takePeak() > 0.9f, "peak meter reports signal");

  vb::OutputStage knee;
  std::int16_t hot[64];
  for (auto& s : hot) s = 32000;
  knee.process(hot, 64);
  check(std::abs(static_cast<int>(hot[63])) < 31500, "soft knee tames near full-scale input");
  stage.setGainDb(-100.0f);
  check(stage.gain() > 0.0f, "gain is clamped");

  vb::OutputStage neutral;
  std::int16_t dc[8192] = {};
  for (auto& s : dc) s = 8000;
  neutral.process(dc, 8192);
  check(std::abs(static_cast<int>(dc[8191])) < 200, "dc blocker removes offset");
}

void testWav() {
  const char* path = "voxbridge-selftest.wav";
  {
    vb::WavWriter writer;
    check(writer.open(path, 48000, 1), "wav opens");
    std::vector<std::int16_t> tone(4800, 1000);
    writer.write(tone.data(), tone.size());
  }
  std::FILE* f = std::fopen(path, "rb");
  check(f != nullptr, "wav file exists");
  if (f) {
    unsigned char header[44] = {};
    const std::size_t got = std::fread(header, 1, sizeof(header), f);
    std::fclose(f);
    check(got == 44 && std::memcmp(header, "RIFF", 4) == 0, "wav riff header");
    check(vb::rd32(header + 40) == 9600, "wav data size patched");
  }
  std::remove(path);
}

}  // namespace

int main() {
  std::printf("VoxBridge core self-test\n");
  testHeader();
  testGoldenVectors();
  testAdpcm();
  testRing();
  testOutputStage();
  testWav();
  if (gFailures == 0) {
    std::printf("OK: all checks passed\n");
    return 0;
  }
  std::printf("FAILED: %d checks\n", gFailures);
  return 1;
}
