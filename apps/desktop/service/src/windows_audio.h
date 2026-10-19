// Native Windows audio output for the VoxBridge capture service.
// Shared-mode WASAPI with automatic PCM conversion, event-driven rendering.
#pragma once

#ifdef _WIN32

#include <cstdint>
#include <string>
#include <vector>

#include "vb_core.h"

namespace vbwin {

struct Device {
  std::string id;
  std::string name;
  bool isDefault = false;
};

std::string utf8(const std::wstring& value);
std::vector<Device> listDevices(bool capture);
bool verifySignature(const std::wstring& path, std::string* detail);

class Renderer {
 public:
  Renderer();
  ~Renderer();

  bool open(const std::string& deviceMatch, std::uint32_t sampleRate, int bufferMs,
            bool nullSink, std::string* error, bool* usedFallback);
  void close();

  // Renders whatever is available, padding with silence. Returns false when the
  // endpoint was invalidated and the caller should reopen.
  bool pump(vb::PcmRing& ring, vb::OutputStage& stage);

  bool ready() const { return rendered_ != nullptr; }
  const std::string& deviceName() const { return deviceName_; }
  bool fallback() const { return fallback_; }
  bool nullSink() const { return nullSink_; }
  std::uint64_t framesRendered() const { return framesRendered_; }

 private:
  struct Impl;
  Impl* impl_ = nullptr;
  void* rendered_ = nullptr;  // IAudioRenderClient*
  std::string deviceName_;
  bool fallback_ = false;
  bool nullSink_ = false;
  std::uint64_t framesRendered_ = 0;
};

}  // namespace vbwin

#endif  // _WIN32
