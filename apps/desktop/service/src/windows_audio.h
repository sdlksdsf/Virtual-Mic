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

// Returns the endpoint id of the current default capture device, or an empty
// string when Windows cannot report one.
std::string defaultCaptureId();

// Makes the given capture endpoint the system default so that Discord, Chrome,
// Teams and every other app pick it up without being configured by hand.
bool setDefaultCapture(const std::string& deviceId);

// True when the friendly name looks like a virtual cable that apps can record
// from (VB-CABLE, VoiceMeeter, Virtual Audio Cable).
bool isVirtualCaptureName(const std::string& name);

// True when the render name is a virtual cable VoxBridge may safely write into.
// Anything else — speakers, headphones, HDMI — must never receive microphone
// audio: the room hears it and the phone picks it back up as an echo.
bool isVirtualRenderName(const std::string& name);

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
