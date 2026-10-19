#ifdef _WIN32

#include "windows_audio.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <objbase.h>

#include <cctype>
#include <wrl/client.h>

#include <audioclient.h>
#include <mmdeviceapi.h>
#include <softpub.h>
#include <wintrust.h>

#include <algorithm>
#include <cstdio>
#include <cstring>

using Microsoft::WRL::ComPtr;

namespace vbwin {
namespace {

// {a45c254e-df1c-4efd-8020-67d146a850e0}, 14 — the friendly-name property.
// Declared locally so the same source builds with MSVC and mingw-w64, whose
// <functiondiscoverykeys_devpkey.h> guards differ.
constexpr PROPERTYKEY kDeviceFriendlyName = {
    {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}},
    14};

std::string narrow(const wchar_t* value) {
  if (!value) return {};
  int len = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (len <= 1) return {};
  std::string out(static_cast<std::size_t>(len), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, out.data(), len, nullptr, nullptr);
  out.resize(static_cast<std::size_t>(len - 1));
  return out;
}

std::wstring widen(const std::string& value) {
  if (value.empty()) return {};
  int len = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
  if (len <= 1) return {};
  std::wstring out(static_cast<std::size_t>(len), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, out.data(), len);
  out.resize(static_cast<std::size_t>(len - 1));
  return out;
}

std::string lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return value;
}

std::string friendlyName(IMMDevice* device) {
  ComPtr<IPropertyStore> props;
  if (FAILED(device->OpenPropertyStore(STGM_READ, &props))) return {};
  PROPVARIANT value;
  PropVariantInit(&value);
  std::string name;
  if (SUCCEEDED(props->GetValue(kDeviceFriendlyName, &value)) && value.vt == VT_LPWSTR) {
    name = narrow(value.pwszVal);
  }
  PropVariantClear(&value);
  return name;
}

std::string endpointId(IMMDevice* device) {
  LPWSTR id = nullptr;
  std::string out;
  if (SUCCEEDED(device->GetId(&id)) && id) {
    out = narrow(id);
    CoTaskMemFree(id);
  }
  return out;
}

bool containsMatch(IMMDevice* device, const std::string& matchLower) {
  const std::string name = lower(friendlyName(device));
  return !name.empty() && name.find(matchLower) != std::string::npos;
}

std::vector<Device> collect(bool capture, IMMDevice* defaultDevice) {
  std::vector<Device> result;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              IID_PPV_ARGS(&enumerator)))) {
    return result;
  }
  ComPtr<IMMDeviceCollection> collection;
  const EDataFlow flow = capture ? eCapture : eRender;
  if (FAILED(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &collection))) {
    return result;
  }
  UINT count = 0;
  if (FAILED(collection->GetCount(&count))) return result;

  std::string defaultId;
  if (defaultDevice) defaultId = endpointId(defaultDevice);

  for (UINT i = 0; i < count; ++i) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(i, &device))) continue;
    Device info;
    info.id = endpointId(device.Get());
    info.name = friendlyName(device.Get());
    info.isDefault = !defaultId.empty() && info.id == defaultId;
    result.push_back(std::move(info));
  }
  return result;
}

}  // namespace

std::string utf8(const std::wstring& value) { return narrow(value.c_str()); }

std::vector<Device> listDevices(bool capture) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              IID_PPV_ARGS(&enumerator)))) {
    return {};
  }
  ComPtr<IMMDevice> def;
  enumerator->GetDefaultAudioEndpoint(capture ? eCapture : eRender, eConsole, &def);
  return collect(capture, def.Get());
}

bool verifySignature(const std::wstring& path, std::string* detail) {
  WINTRUST_FILE_INFO fileInfo{};
  fileInfo.cbStruct = sizeof(fileInfo);
  fileInfo.pcwszFilePath = path.c_str();

  GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  WINTRUST_DATA data{};
  data.cbStruct = sizeof(data);
  data.dwUIChoice = WTD_UI_NONE;
  data.fdwRevocationChecks = WTD_REVOKE_NONE;
  data.dwUnionChoice = WTD_CHOICE_FILE;
  data.pFile = &fileInfo;
  data.dwStateAction = WTD_STATEACTION_VERIFY;
  data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL;

  const LONG status = WinVerifyTrust(nullptr, &policy, &data);
  data.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(nullptr, &policy, &data);

  if (status == ERROR_SUCCESS) {
    if (detail) *detail = "signature-valid";
    return true;
  }
  if (detail) {
    switch (status) {
      case TRUST_E_NOSIGNATURE:
        *detail = "not-signed";
        break;
      case TRUST_E_EXPLICIT_DISTRUST:
        *detail = "explicitly-distrusted";
        break;
      case TRUST_E_SUBJECT_NOT_TRUSTED:
        *detail = "subject-not-trusted";
        break;
      case CRYPT_E_SECURITY_SETTINGS:
        *detail = "security-settings";
        break;
      default:
        *detail = "invalid-signature";
        break;
    }
  }
  return false;
}

struct Renderer::Impl {
  ComPtr<IMMDeviceEnumerator> enumerator;
  ComPtr<IMMDevice> device;
  ComPtr<IAudioClient> client;
  ComPtr<IAudioRenderClient> render;
  HANDLE event = nullptr;
  UINT32 bufferFrames = 0;
  UINT32 rate = 48000;
  bool silentStarted = false;
  std::uint32_t underruns = 0;
};

Renderer::Renderer() = default;
Renderer::~Renderer() { close(); }

bool Renderer::open(const std::string& deviceMatch, std::uint32_t sampleRate, int bufferMs,
                    bool nullSinkRequested, std::string* error, bool* usedFallback) {
  close();
  nullSink_ = nullSinkRequested;
  fallback_ = false;
  if (usedFallback) *usedFallback = false;
  if (nullSink_) {
    deviceName_ = "Null sink (no audio endpoint)";
    return true;
  }

  impl_ = new Impl();
  impl_->rate = sampleRate;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              IID_PPV_ARGS(&impl_->enumerator)))) {
    if (error) *error = "windows-audio-enumerator-unavailable";
    close();
    return false;
  }

  ComPtr<IMMDevice> chosen;
  const std::string match = lower(deviceMatch);
  if (!match.empty()) {
    ComPtr<IMMDeviceCollection> collection;
    if (SUCCEEDED(impl_->enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE,
                                                        &collection))) {
      UINT count = 0;
      collection->GetCount(&count);
      for (UINT i = 0; i < count && !chosen; ++i) {
        ComPtr<IMMDevice> candidate;
        if (FAILED(collection->Item(i, &candidate))) continue;
        if (containsMatch(candidate.Get(), match)) {
          chosen = candidate;
          deviceName_ = friendlyName(candidate.Get());
        }
      }
    }
  }

  if (!chosen) {
    // Fall back to the default render endpoint. Callers surface a warning:
    // without a virtual cable the audio is only audible, not a microphone.
    if (FAILED(impl_->enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &chosen))) {
      if (error) *error = "no-audio-endpoint";
      close();
      return false;
    }
    deviceName_ = friendlyName(chosen.Get());
    fallback_ = true;
    if (usedFallback) *usedFallback = true;
  }

  impl_->device = chosen;
  if (FAILED(impl_->device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                     reinterpret_cast<void**>(impl_->client.GetAddressOf())))) {
    if (error) *error = "audio-client-unavailable";
    close();
    return false;
  }

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 1;
  format.nSamplesPerSec = sampleRate;
  format.wBitsPerSample = 16;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;

  const int clampedBuffer = std::max(10, std::min(200, bufferMs));
  REFERENCE_TIME duration = static_cast<REFERENCE_TIME>(clampedBuffer) * 10000;
  DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  HRESULT hr = impl_->client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, duration, 0, &format,
                                         nullptr);
  if (FAILED(hr)) {
    if (error) *error = "audio-init-failed-" + std::to_string(static_cast<long>(hr));
    close();
    return false;
  }

  impl_->event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!impl_->event || FAILED(impl_->client->SetEventHandle(impl_->event))) {
    if (error) *error = "audio-event-failed";
    close();
    return false;
  }
  if (FAILED(impl_->client->GetBufferSize(&impl_->bufferFrames))) {
    if (error) *error = "audio-buffer-failed";
    close();
    return false;
  }
  if (FAILED(impl_->client->GetService(IID_PPV_ARGS(&impl_->render)))) {
    if (error) *error = "audio-render-service-failed";
    close();
    return false;
  }
  rendered_ = impl_->render.Get();
  impl_->client->Start();
  return true;
}

void Renderer::close() {
  if (!impl_) {
    rendered_ = nullptr;
    return;
  }
  if (impl_->client) impl_->client->Stop();
  if (impl_->event) CloseHandle(impl_->event);
  impl_->client.Reset();
  impl_->render.Reset();
  impl_->device.Reset();
  impl_->enumerator.Reset();
  delete impl_;
  impl_ = nullptr;
  rendered_ = nullptr;
  deviceName_.clear();
  framesRendered_ = 0;
}

bool Renderer::pump(vb::PcmRing& ring, vb::OutputStage& stage) {
  if (!impl_) return true;
  if (nullSink_) return true;

  WaitForSingleObject(impl_->event, 40);
  UINT32 padding = 0;
  HRESULT hr = impl_->client->GetCurrentPadding(&padding);
  if (hr == AUDCLNT_E_DEVICE_INVALIDATED) return false;
  if (FAILED(hr)) return false;

  UINT32 available = impl_->bufferFrames - padding;
  if (available == 0) return true;
  if (available > 4096) available = 4096;

  BYTE* data = nullptr;
  hr = impl_->render->GetBuffer(available, &data);
  if (hr == AUDCLNT_E_DEVICE_INVALIDATED) return false;
  if (FAILED(hr) || !data) return true;

  static thread_local std::vector<std::int16_t> scratch;
  if (scratch.size() < available) scratch.resize(available);
  const std::size_t real = ring.read(scratch.data(), available);
  if (real < available) ++impl_->underruns;
  stage.process(scratch.data(), available);
  std::memcpy(data, scratch.data(), available * sizeof(std::int16_t));
  impl_->render->ReleaseBuffer(available, 0);
  framesRendered_ += available;
  return true;
}

}  // namespace vbwin

#endif  // _WIN32
