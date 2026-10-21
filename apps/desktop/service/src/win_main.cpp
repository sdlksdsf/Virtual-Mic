// VoxBridge native capture service (Windows).
//
// Receives framed PCM from the desktop app on stdin and renders it to a
// virtual audio cable (or the default endpoint) through WASAPI. Emits JSON
// lines on stdout for the Electron layer: ready, meter, stats, errors.
//
// Flags:
//   --list-devices            print render + capture endpoints as JSON
//   --device <substring>      endpoint name match (default: virtual cable)
//   --rate <hz>               stream rate, default 48000
//   --buffer-ms <n>           WASAPI buffer, default 20
//   --prefill-ms <n>          software jitter target, default 80
//   --wav-out <path>          mirror received audio to a WAV file
//   --null-sink               run without an audio endpoint (tests)
//   --verify <path>           verify an Authenticode signature
//   --log <path>              append service events to a log file
//   --version

#include "vb_core.h"
#include "windows_audio.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <objbase.h>
#include <shellapi.h>

#include <cctype>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr const char* kServiceVersion = "1.1.0";
constexpr const char* kDefaultDevices[] = {"cable input", "voxbridge virtual microphone",
                                           "voicemeeter input", "virtual audio cable", "line 1 ("};

std::mutex gOutMutex;
std::FILE* gLog = nullptr;
std::atomic<bool> gQuit{false};
// Default capture endpoint that was active before we claimed the cable, so the
// machine is left exactly as we found it when the service stops.
std::string gPreviousDefaultCapture;
std::atomic<bool> gStdinClosed{false};

void emitRaw(const std::string& line) {
  std::lock_guard<std::mutex> lock(gOutMutex);
  std::fputs(line.c_str(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
  if (gLog) {
    std::fputs(line.c_str(), gLog);
    std::fputc('\n', gLog);
    std::fflush(gLog);
  }
}

void emit(const std::string& json) { emitRaw(json); }

std::string jsonString(const std::string& value) { return "\"" + vb::jsonEscape(value) + "\""; }

std::string stripQuotes(std::string value) {
  if (value.size() >= 2 && value.front() == '"' && value.back() == '"') {
    value = value.substr(1, value.size() - 2);
  }
  return value;
}

bool findJsonString(const std::string& src, const std::string& key, std::string* out) {
  const std::string needle = "\"" + key + "\"";
  std::size_t pos = src.find(needle);
  if (pos == std::string::npos) return false;
  pos = src.find(':', pos + needle.size());
  if (pos == std::string::npos) return false;
  ++pos;
  while (pos < src.size() && (src[pos] == ' ' || src[pos] == '\t')) ++pos;
  if (pos >= src.size() || src[pos] != '"') return false;
  const std::size_t end = src.find('"', pos + 1);
  if (end == std::string::npos) return false;
  *out = src.substr(pos + 1, end - pos - 1);
  return true;
}

bool findJsonNumber(const std::string& src, const std::string& key, double* out) {
  const std::string needle = "\"" + key + "\"";
  std::size_t pos = src.find(needle);
  if (pos == std::string::npos) return false;
  pos = src.find(':', pos + needle.size());
  if (pos == std::string::npos) return false;
  *out = std::atof(src.c_str() + pos + 1);
  return true;
}

std::vector<std::string> argsToUtf8(int argc, wchar_t** argv) {
  std::vector<std::string> args;
  for (int i = 1; i < argc; ++i) args.push_back(vbwin::utf8(argv[i]));
  return args;
}

struct Options {
  std::string device;
  std::uint32_t rate = 48000;
  int bufferMs = 20;
  int prefillMs = 60;
  std::string wavOut;
  std::string logPath;
  std::string verifyPath;
  bool listDevices = false;
  bool nullSink = false;
  bool version = false;
  // Claim the system default recording device so every app picks the virtual
  // cable up without being configured by hand. The previous default is
  // restored on shutdown.
  bool claimDefault = false;
  std::string restoreDefault;
};

Options parseOptions(const std::vector<std::string>& args) {
  Options opt;
  for (std::size_t i = 0; i < args.size(); ++i) {
    const std::string& a = args[i];
    auto next = [&](std::string fallback) {
      return (i + 1 < args.size()) ? args[++i] : fallback;
    };
    if (a == "--device") opt.device = next("");
    else if (a == "--rate") opt.rate = static_cast<std::uint32_t>(std::atoi(next("48000").c_str()));
    else if (a == "--buffer-ms") opt.bufferMs = std::atoi(next("20").c_str());
    else if (a == "--prefill-ms") opt.prefillMs = std::atoi(next("80").c_str());
    else if (a == "--wav-out") opt.wavOut = next("");
    else if (a == "--log") opt.logPath = next("");
    else if (a == "--verify") opt.verifyPath = next("");
    else if (a == "--null-sink") opt.nullSink = true;
    else if (a == "--claim-default") opt.claimDefault = true;
    else if (a == "--restore-default") opt.restoreDefault = next("");
    else if (a == "--list-devices") opt.listDevices = true;
    else if (a == "--version") opt.version = true;
  }
  if (opt.rate < 8000 || opt.rate > 96000) opt.rate = 48000;
  if (opt.prefillMs < 20) opt.prefillMs = 20;
  if (opt.prefillMs > 500) opt.prefillMs = 500;
  if (opt.bufferMs < 10) opt.bufferMs = 10;
  if (opt.bufferMs > 100) opt.bufferMs = 100;
  return opt;
}

std::string devicesJson() {
  auto render = vbwin::listDevices(false);
  auto capture = vbwin::listDevices(true);
  auto encode = [](const std::vector<vbwin::Device>& devices) {
    std::string out = "[";
    for (std::size_t i = 0; i < devices.size(); ++i) {
      if (i) out += ",";
      out += "{\"name\":" + jsonString(devices[i].name) + ",\"id\":" +
             jsonString(devices[i].id) + ",\"default\":" +
             (devices[i].isDefault ? "true" : "false") + "}";
    }
    return out + "]";
  };
  return "{\"ev\":\"devices\",\"version\":" + jsonString(kServiceVersion) +
         ",\"render\":" + encode(render) + ",\"capture\":" + encode(capture) + "}";
}

std::string pickDevice(const std::string& requested) {
  if (!requested.empty()) return requested;
  const char* env = std::getenv("VOXBRIDGE_DEVICE");
  if (env && *env) return env;
  const auto render = vbwin::listDevices(false);
  for (const char* candidate : kDefaultDevices) {
    for (const auto& device : render) {
      std::string lowerName = device.name;
      for (char& c : lowerName) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      if (lowerName.find(candidate) != std::string::npos) return device.name;
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// stdin frame reader
// ---------------------------------------------------------------------------
struct StdinState {
  vb::PcmRing* ring = nullptr;
  vb::WavWriter* wav = nullptr;
  vb::OutputStage* stage = nullptr;
  std::atomic<std::uint64_t>* received = nullptr;
  std::atomic<std::uint64_t>* packets = nullptr;
  std::atomic<std::uint16_t>* lastSeq = nullptr;
  std::atomic<bool>* sawData = nullptr;
};

bool readExact(HANDLE handle, void* buffer, DWORD bytes) {
  DWORD total = 0;
  auto* p = static_cast<unsigned char*>(buffer);
  while (total < bytes) {
    DWORD got = 0;
    if (!ReadFile(handle, p + total, bytes - total, &got, nullptr) || got == 0) return false;
    total += got;
  }
  return true;
}

void handleControl(const std::string& json, vb::OutputStage& stage, vb::PcmRing& ring) {
  std::string cmd;
  if (!findJsonString(json, "cmd", &cmd)) return;
  if (cmd == "volume") {
    double db = 0;
    if (findJsonNumber(json, "db", &db)) stage.setGainDb(static_cast<float>(db));
  } else if (cmd == "flush") {
    ring.clear();
  } else if (cmd == "quit") {
    gQuit.store(true);
  } else if (cmd == "ping") {
    double id = 0;
    findJsonNumber(json, "id", &id);
    emit("{\"ev\":\"pong\",\"id\":" + std::to_string(static_cast<long long>(id)) + "}");
  }
}

void stdinLoop(HANDLE input, StdinState state) {
  std::vector<unsigned char> payload;
  while (!gQuit.load()) {
    std::uint32_t length = 0;
    if (!readExact(input, &length, sizeof(length))) break;
    if (length == 0 || length > 256 * 1024) break;
    payload.resize(length);
    if (!readExact(input, payload.data(), length)) break;
    if (payload[0] == vb::kMagic) {
      vb::PacketView view;
      if (!vb::parseHeader(payload.data(), payload.size(), view)) continue;
      std::vector<std::int16_t> samples;
      if (view.codec == vb::kCodecPcm16) {
        samples.resize(view.payload_len / 2);
        std::memcpy(samples.data(), view.payload, samples.size() * sizeof(std::int16_t));
      } else if (view.codec == vb::kCodecAdpcm) {
        samples = vb::decodeAdpcm(view.payload, view.payload_len);
      } else {
        continue;
      }
      if (view.flags & 0x02) {
        state.ring->clear();
        continue;
      }
      state.ring->push(samples.data(), samples.size());
      if (state.wav && state.wav->isOpen()) state.wav->write(samples.data(), samples.size());
      state.received->fetch_add(samples.size());
      state.packets->fetch_add(1);
      state.lastSeq->store(view.seq);
      state.sawData->store(true);
    } else if (payload[0] == '{') {
      std::string json(reinterpret_cast<char*>(payload.data()), payload.size());
      handleControl(json, *state.stage, *state.ring);
    }
  }
  gStdinClosed.store(true);
  gQuit.store(true);
}

int runService(const Options& opt) {
  if (!opt.logPath.empty()) gLog = std::fopen(opt.logPath.c_str(), "a");

  emit("{\"ev\":\"boot\",\"version\":" + jsonString(kServiceVersion) +
       ",\"protocol\":1,\"pid\":" + std::to_string(GetCurrentProcessId()) + "}");

  const std::uint32_t ringRate = opt.rate > 0 ? opt.rate : 48000;
  vb::PcmRing ring(static_cast<std::size_t>(ringRate) * 8 + 4096);
  vb::OutputStage stage;
  vb::WavWriter wav;
  if (!opt.wavOut.empty() && !wav.open(opt.wavOut, opt.rate, 1)) {
    emit("{\"ev\":\"warn\",\"message\":\"wav-open-failed\"}");
  }

  const std::string device = pickDevice(opt.device);
  vbwin::Renderer renderer;
  std::string error;
  bool fallback = false;
  bool open = renderer.open(device, opt.rate, opt.bufferMs, opt.nullSink, &error, &fallback);
  if (!open) {
    emit("{\"ev\":\"error\",\"code\":" + jsonString(error) +
         ",\"message\":\"Could not open an audio output. Install a virtual microphone or use --null-sink.\"}");
    gQuit.store(true);
  } else {
    emit("{\"ev\":\"ready\",\"device\":" + jsonString(renderer.deviceName()) +
         ",\"fallback\":" + (renderer.fallback() ? "true" : "false") +
         ",\"nullSink\":" + (renderer.nullSink() ? "true" : "false") +
         ",\"rate\":" + std::to_string(opt.rate) +
         ",\"bufferMs\":" + std::to_string(opt.bufferMs) +
         ",\"prefillMs\":" + std::to_string(opt.prefillMs) + "}");
    if (renderer.nullSink() && !opt.nullSink) {
      // Deliberately silent instead of playing the caller's voice out of the
      // speakers, which the phone would hear and loop back.
      emit("{\"ev\":\"warn\",\"code\":\"no-virtual-cable\",\"message\":\"No virtual microphone found. Audio is not sent anywhere until the cable is installed.\"}");
    }

    // Point the system default *recording* device at the cable output so
    // Discord, Chrome, Teams and OBS capture it without manual setup. Apps read
    // the default endpoint, not the device VoxBridge renders into, so without
    // this step they keep recording from the laptop microphone.
    if (opt.claimDefault && !renderer.fallback() && !renderer.nullSink()) {
      std::string targetId;
      std::string targetName;
      for (const auto& device : vbwin::listDevices(true)) {
        if (!vbwin::isVirtualCaptureName(device.name)) continue;
        if (targetId.empty() || device.name.size() < targetName.size()) {
          targetId = device.id;
          targetName = device.name;
        }
      }
      if (!targetId.empty()) {
        const std::string previous = vbwin::defaultCaptureId();
        const bool claimed = vbwin::setDefaultCapture(targetId);
        emit("{\"ev\":\"default-input\",\"claimed\":" +
             std::string(claimed ? "true" : "false") + ",\"device\":" +
             jsonString(targetName) + ",\"previous\":" + jsonString(previous) + "}");
        if (claimed) gPreviousDefaultCapture = previous;
      } else {
        emit("{\"ev\":\"warn\",\"code\":\"no-capture-cable\",\"message\":\"No virtual recording device found. Install VB-CABLE, then reopen VoxBridge.\"}");
      }
    }
  }

  std::atomic<std::uint64_t> received{0};
  std::atomic<std::uint64_t> packets{0};
  std::atomic<std::uint16_t> lastSeq{0};
  std::atomic<bool> sawData{false};
  StdinState state{&ring, &wav, &stage, &received, &packets, &lastSeq, &sawData};
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  std::thread reader;
  if (input && input != INVALID_HANDLE_VALUE) {
    reader = std::thread(stdinLoop, input, state);
  } else {
    gStdinClosed.store(true);
  }

  auto lastStats = std::chrono::steady_clock::now();
  auto lastMeter = std::chrono::steady_clock::now();
  auto lastFrame = std::chrono::steady_clock::now();
  std::uint64_t lastPackets = 0;
  bool reportedUnderrun = false;

  while (!gQuit.load()) {
    if (renderer.ready() && !renderer.nullSink()) {
      if (!renderer.pump(ring, stage)) {
        emit("{\"ev\":\"device_lost\"}");
        renderer.close();
        std::this_thread::sleep_for(std::chrono::milliseconds(400));
        bool usedFallback = false;
        if (!renderer.open(device, opt.rate, opt.bufferMs, false, &error, &usedFallback)) {
          emit("{\"ev\":\"error\",\"code\":" + jsonString(error) + ",\"message\":\"Audio device lost\"}");
          break;
        }
        emit("{\"ev\":\"ready\",\"device\":" + jsonString(renderer.deviceName()) +
             ",\"fallback\":" + (renderer.fallback() ? "true" : "false") +
             ",\"nullSink\":" + (renderer.nullSink() ? "true" : "false") +
             ",\"rate\":" + std::to_string(opt.rate) + "}");
      }
    } else if (renderer.nullSink()) {
      // Consume the ring at the device rate so meters and buffer stats are real.
      std::vector<std::int16_t> scratch(opt.rate / 100);
      ring.read(scratch.data(), scratch.size());
      stage.process(scratch.data(), scratch.size());
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    const auto now = std::chrono::steady_clock::now();
    if (std::chrono::duration_cast<std::chrono::milliseconds>(now - lastMeter).count() >= 100) {
      const float peak = stage.takePeak();
      emit("{\"ev\":\"meter\",\"peak\":" + std::to_string(peak) + "}");
      lastMeter = now;
    }
    if (std::chrono::duration_cast<std::chrono::milliseconds>(now - lastStats).count() >= 1000) {
      const double bufferedMs =
          1000.0 * static_cast<double>(ring.available()) / static_cast<double>(opt.rate);
      const std::uint64_t pkts = packets.load();
      const double pps = static_cast<double>(pkts - lastPackets);
      lastPackets = pkts;
      emit("{\"ev\":\"stats\",\"bufferedMs\":" + std::to_string(bufferedMs) +
           ",\"underruns\":" + std::to_string(ring.underruns()) +
           ",\"dropped\":" + std::to_string(ring.dropped()) +
           ",\"packetsPerSecond\":" + std::to_string(pps) +
           ",\"frames\":" + std::to_string(renderer.framesRendered()) +
           ",\"device\":\"" + vb::jsonEscape(renderer.deviceName()) + "\"}");
      if (ring.underruns() > 0 && !reportedUnderrun) {
        emit("{\"ev\":\"warn\",\"code\":\"underrun\",\"message\":\"Audio buffer starved; increase the jitter buffer.\"}");
        reportedUnderrun = true;
      }
      lastStats = now;
    }
    if (sawData.load()) lastFrame = now;
    (void)lastFrame;
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }

  gQuit.store(true);
  if (reader.joinable()) {
    // The reader may be blocked on ReadFile when the parent disappears.
    // Closing stdin from another thread is not possible; detach instead.
    reader.detach();
  }
  renderer.close();
  wav.close();
  if (received.load() > 0) {
    emit("{\"ev\":\"summary\",\"frames\":" + std::to_string(received.load()) +
         ",\"packets\":" + std::to_string(packets.load()) + "}");
  }
  // Hand the default recording device back to the machine's own microphone.
  if (!gPreviousDefaultCapture.empty()) {
    vbwin::setDefaultCapture(gPreviousDefaultCapture);
    emit("{\"ev\":\"default-input-restored\"}");
    gPreviousDefaultCapture.clear();
  }
  emit("{\"ev\":\"bye\"}");
  if (gLog) std::fclose(gLog);
  return 0;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  int argc = 0;
  wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  std::vector<std::string> args = argv ? argsToUtf8(argc, argv) : std::vector<std::string>{};
  if (argv) LocalFree(argv);

  const Options opt = parseOptions(args);
  if (opt.version) {
    emit("{\"ev\":\"version\",\"version\":" + jsonString(kServiceVersion) +
         ",\"protocol\":1,\"arch\":\"x64\"}");
    return 0;
  }

  HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  if (opt.listDevices) {
    emit(devicesJson());
    if (SUCCEEDED(com)) CoUninitialize();
    return 0;
  }
  if (!opt.verifyPath.empty()) {
    std::wstring wide;
    const int needed = MultiByteToWideChar(CP_UTF8, 0, opt.verifyPath.c_str(), -1, nullptr, 0);
    if (needed > 0) {
      wide.resize(static_cast<std::size_t>(needed - 1));
      MultiByteToWideChar(CP_UTF8, 0, opt.verifyPath.c_str(), -1, wide.data(), needed);
    }
    std::string detail;
    const bool valid = vbwin::verifySignature(wide, &detail);
    emit("{\"ev\":\"verify\",\"valid\":" + std::string(valid ? "true" : "false") +
         ",\"detail\":" + jsonString(detail) + ",\"path\":" + jsonString(opt.verifyPath) + "}");
    if (SUCCEEDED(com)) CoUninitialize();
    return valid ? 0 : 2;
  }

  const int result = runService(opt);
  if (SUCCEEDED(com)) CoUninitialize();
  return result;
}
