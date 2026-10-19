// VoxBridge setup (Windows).
//
// A single self-contained installer. The application payload is appended to
// this executable at build time, decompressed with miniz, and written to
// %LOCALAPPDATA%\Programs\VoxBridge. Shortcuts and an uninstall entry are
// created for the current user, so no administrator rights are required.

#include <windows.h>
#include <commctrl.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <shellapi.h>
#include <objbase.h>
#include <string>
#include <vector>
#include <filesystem>
#include <cstdint>
#include "miniz.h"

namespace fs = std::filesystem;

static const wchar_t kAppName[] = L"VoxBridge";
static const wchar_t kVersion[] = L"1.0.0";
static const char kFooterMagic[8] = {'V', 'B', 'X', 'P', 'A', 'Y', '1', 0};
static const char kArchiveMagic[4] = {'V', 'B', 'X', 'P'};

struct Footer {
  char magic[8];
  uint64_t offset;
  uint64_t size;
};

static HWND gWindow = nullptr;
static HWND gBar = nullptr;
static HWND gLabel = nullptr;

static std::wstring knownFolder(REFKNOWNFOLDERID id) {
  PWSTR path = nullptr;
  std::wstring result;
  if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_CREATE, nullptr, &path)) && path) {
    result = path;
    CoTaskMemFree(path);
  }
  return result;
}

static void pumpMessages() {
  MSG message;
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
}

static LRESULT CALLBACK progressProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  if (message == WM_PAINT) {
    PAINTSTRUCT paint;
    HDC dc = BeginPaint(window, &paint);
    RECT rect;
    GetClientRect(window, &rect);
    HBRUSH brush = CreateSolidBrush(RGB(247, 244, 236));
    FillRect(dc, &rect, brush);
    DeleteObject(brush);
    EndPaint(window, &paint);
    return 0;
  }
  if (message == WM_CLOSE) return 0;
  return DefWindowProcW(window, message, wParam, lParam);
}

static void createProgressWindow() {
  WNDCLASSEXW cls{};
  cls.cbSize = sizeof(cls);
  cls.lpfnWndProc = progressProc;
  cls.hInstance = GetModuleHandleW(nullptr);
  cls.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  cls.lpszClassName = L"VoxBridgeSetup";
  RegisterClassExW(&cls);

  const int width = 480;
  const int height = 170;
  const int x = (GetSystemMetrics(SM_CXSCREEN) - width) / 2;
  const int y = (GetSystemMetrics(SM_CYSCREEN) - height) / 2;
  gWindow = CreateWindowExW(WS_EX_TOPMOST, L"VoxBridgeSetup", L"VoxBridge Setup",
                            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, x, y, width, height,
                            nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!gWindow) return;

  CreateWindowExW(0, L"STATIC", L"VoxBridge", WS_CHILD | WS_VISIBLE, 28, 24, 420, 30, gWindow,
                  nullptr, nullptr, nullptr);
  gLabel = CreateWindowExW(0, L"STATIC", L"Preparing files...", WS_CHILD | WS_VISIBLE, 28, 66, 420,
                           22, gWindow, nullptr, nullptr, nullptr);
  gBar = CreateWindowExW(0, PROGRESS_CLASSW, nullptr, WS_CHILD | WS_VISIBLE, 28, 102, 420, 16,
                         gWindow, nullptr, nullptr, nullptr);

  HFONT titleFont = CreateFontW(26, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                                OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                DEFAULT_PITCH, L"Segoe UI");
  SendMessageW(GetWindow(gWindow, GW_CHILD), WM_SETFONT, reinterpret_cast<WPARAM>(titleFont), TRUE);

  ShowWindow(gWindow, SW_SHOW);
  UpdateWindow(gWindow);
  pumpMessages();
}

static void setProgress(int percent, const wchar_t* text) {
  if (gBar) SendMessageW(gBar, PBM_SETPOS, static_cast<WPARAM>(percent), 0);
  if (gLabel && text) SetWindowTextW(gLabel, text);
  if (gWindow) UpdateWindow(gWindow);
  pumpMessages();
}

static bool readPayload(const fs::path& self, std::vector<unsigned char>& data) {
  HANDLE file = CreateFileW(self.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;

  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size) || size.QuadPart < static_cast<LONGLONG>(sizeof(Footer))) {
    CloseHandle(file);
    return false;
  }

  Footer footer{};
  LARGE_INTEGER position{};
  position.QuadPart = size.QuadPart - static_cast<LONGLONG>(sizeof(Footer));
  DWORD read = 0;
  bool ok = SetFilePointerEx(file, position, nullptr, FILE_BEGIN) &&
            ReadFile(file, &footer, sizeof(footer), &read, nullptr) && read == sizeof(footer) &&
            memcmp(footer.magic, kFooterMagic, sizeof(kFooterMagic)) == 0 &&
            footer.offset + footer.size <= static_cast<uint64_t>(size.QuadPart);
  if (!ok) {
    CloseHandle(file);
    return false;
  }

  data.resize(static_cast<size_t>(footer.size));
  position.QuadPart = static_cast<LONGLONG>(footer.offset);
  ok = SetFilePointerEx(file, position, nullptr, FILE_BEGIN) &&
       ReadFile(file, data.data(), static_cast<DWORD>(data.size()), &read, nullptr) &&
       read == data.size();
  CloseHandle(file);
  return ok;
}

static bool safeRelative(const std::wstring& path) {
  if (path.empty() || path.size() > 512) return false;
  if (path[0] == L'/' || path[0] == L'\\') return false;
  if (path.find(L':') != std::wstring::npos) return false;
  size_t start = 0;
  while (start < path.size()) {
    const size_t end = path.find_first_of(L"\\/", start);
    const std::wstring part = path.substr(start, end == std::wstring::npos ? std::wstring::npos : end - start);
    if (part == L"..") return false;
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  return true;
}

static bool writeFile(const fs::path& target, const std::vector<unsigned char>& bytes) {
  std::error_code ec;
  fs::create_directories(target.parent_path(), ec);
  HANDLE file = CreateFileW(target.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  const bool ok = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
                  written == bytes.size();
  CloseHandle(file);
  return ok;
}

static bool extractArchive(const std::vector<unsigned char>& payload, const fs::path& target,
                           int* filesWritten) {
  if (payload.size() < 8 || memcmp(payload.data(), kArchiveMagic, 4) != 0) return false;
  uint32_t count = 0;
  memcpy(&count, payload.data() + 4, sizeof(count));
  if (count == 0 || count > 10000) return false;

  size_t cursor = 8;
  struct Entry {
    std::wstring path;
    uint64_t size;
    uint64_t compressed;
  };
  std::vector<Entry> entries;
  entries.reserve(count);

  for (uint32_t index = 0; index < count; index += 1) {
    if (cursor + 2 > payload.size()) return false;
    uint16_t length = 0;
    memcpy(&length, payload.data() + cursor, sizeof(length));
    cursor += 2;
    if (length == 0 || length > 1024 || cursor + length + 16 > payload.size()) return false;
    const char* raw = reinterpret_cast<const char*>(payload.data() + cursor);
    const int wideLength = MultiByteToWideChar(CP_UTF8, 0, raw, length, nullptr, 0);
    if (wideLength <= 0) return false;
    std::wstring path(static_cast<size_t>(wideLength), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, raw, length, path.data(), wideLength);
    cursor += length;
    Entry entry;
    entry.path = path;
    memcpy(&entry.size, payload.data() + cursor, 8);
    cursor += 8;
    memcpy(&entry.compressed, payload.data() + cursor, 8);
    cursor += 8;
    if (!safeRelative(entry.path)) return false;
    entries.push_back(std::move(entry));
  }

  int written = 0;
  for (const Entry& entry : entries) {
    if (cursor + entry.compressed > payload.size()) return false;
    std::vector<unsigned char> output(static_cast<size_t>(entry.size));
    mz_ulong destinationLength = static_cast<mz_ulong>(output.size());
    const int status = mz_uncompress(output.data(), &destinationLength, payload.data() + cursor,
                                     static_cast<mz_ulong>(entry.compressed));
    cursor += static_cast<size_t>(entry.compressed);
    if (status != MZ_OK || destinationLength != output.size()) return false;

    const fs::path relative(entry.path);
    const fs::path destination = (target / relative).lexically_normal();
    if (!writeFile(destination, output)) return false;

    written += 1;
    const int percent = 5 + (written * 90) / static_cast<int>(entries.size());
    setProgress(percent, (L"Installing " + relative.filename().wstring()).c_str());
  }

  *filesWritten = written;
  return true;
}

static bool createShortcut(const fs::path& link, const fs::path& target, const fs::path& working,
                           const fs::path& icon, const wchar_t* description) {
  IShellLinkW* shellLink = nullptr;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_IShellLinkW,
                              reinterpret_cast<void**>(&shellLink)))) {
    return false;
  }
  shellLink->SetPath(target.c_str());
  shellLink->SetWorkingDirectory(working.c_str());
  shellLink->SetIconLocation(icon.c_str(), 0);
  shellLink->SetDescription(description);

  IPersistFile* persist = nullptr;
  bool ok = false;
  if (SUCCEEDED(shellLink->QueryInterface(IID_IPersistFile, reinterpret_cast<void**>(&persist)))) {
    std::error_code ec;
    fs::create_directories(link.parent_path(), ec);
    ok = SUCCEEDED(persist->Save(link.c_str(), TRUE));
    persist->Release();
  }
  shellLink->Release();
  return ok;
}

static void registerApplication(const fs::path& installDir) {
  HKEY key = nullptr;
  if (RegCreateKeyExW(HKEY_CURRENT_USER,
                      L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VoxBridge", 0,
                      nullptr, 0, KEY_WRITE, nullptr, &key, nullptr) != ERROR_SUCCESS) {
    return;
  }
  auto setString = [&](const wchar_t* name, const std::wstring& value) {
    RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
                   static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
  };
  setString(L"DisplayName", L"VoxBridge 1.0.0");
  setString(L"DisplayVersion", kVersion);
  setString(L"Publisher", L"VoxBridge");
  setString(L"HelpLink", L"https://github.com/sdlksdsf/Virtual-Mic");
  setString(L"URLInfoAbout", L"https://github.com/sdlksdsf/Virtual-Mic");
  setString(L"InstallLocation", installDir.wstring());
  setString(L"DisplayIcon", (installDir / L"voxbridge.ico").wstring());
  setString(L"UninstallString", L"\"" + (installDir / L"VoxBridge-Uninstall.exe").wstring() + L"\"");
  DWORD one = 1;
  RegSetValueExW(key, L"NoModify", 0, REG_DWORD, reinterpret_cast<const BYTE*>(&one), sizeof(one));
  RegSetValueExW(key, L"NoRepair", 0, REG_DWORD, reinterpret_cast<const BYTE*>(&one), sizeof(one));
  RegCloseKey(key);
}

static void installShortcuts(const fs::path& installDir) {
  const fs::path exe = installDir / L"VoxBridge.exe";
  const fs::path icon = installDir / L"voxbridge.ico";
  const std::wstring programs = knownFolder(FOLDERID_Programs);
  const std::wstring desktop = knownFolder(FOLDERID_Desktop);
  if (!programs.empty()) {
    createShortcut(fs::path(programs) / L"VoxBridge.lnk", exe, installDir, icon,
                   L"Your phone, as a microphone");
  }
  if (!desktop.empty()) {
    createShortcut(fs::path(desktop) / L"VoxBridge.lnk", exe, installDir, icon,
                   L"Your phone, as a microphone");
  }
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  INITCOMMONCONTROLSEX controls{};
  controls.dwSize = sizeof(controls);
  controls.dwICC = ICC_PROGRESS_CLASS;
  InitCommonControlsEx(&controls);

  wchar_t selfPath[MAX_PATH * 2];
  if (!GetModuleFileNameW(nullptr, selfPath, static_cast<DWORD>(std::size(selfPath)))) return 1;
  const fs::path self(selfPath);

  std::vector<unsigned char> payload;
  if (!readPayload(self, payload)) {
    MessageBoxW(nullptr,
                L"This installer is incomplete or was modified.\r\n\r\n"
                L"Download VoxBridge again from the official page.",
                L"VoxBridge setup", MB_ICONERROR | MB_OK);
    return 1;
  }

  const fs::path installDir = fs::path(knownFolder(FOLDERID_LocalAppData)) / L"Programs" / L"VoxBridge";
  const int answer = MessageBoxW(
      nullptr,
      L"Install VoxBridge 1.0.0 for this user?\r\n\r\n"
      L"The app is installed in your local app folder, with a Start menu shortcut and an entry in "
      L"Settings > Apps. Administrator rights are not required.",
      L"Install VoxBridge", MB_YESNO | MB_ICONQUESTION);
  if (answer != IDYES) return 0;

  createProgressWindow();
  setProgress(2, L"Preparing...");

  std::error_code ec;
  fs::create_directories(installDir, ec);
  int filesWritten = 0;
  const bool ok = extractArchive(payload, installDir, &filesWritten);
  if (!ok) {
    setProgress(100, L"Installation failed");
    MessageBoxW(nullptr,
                L"VoxBridge could not write its files.\r\n\r\n"
                L"Close VoxBridge if it is running, check free disk space, then try again.",
                L"VoxBridge setup failed", MB_ICONERROR | MB_OK);
    if (gWindow) DestroyWindow(gWindow);
    CoUninitialize();
    return 1;
  }

  setProgress(96, L"Creating shortcuts...");
  installShortcuts(installDir);
  registerApplication(installDir);
  setProgress(100, L"Finished");
  if (gWindow) DestroyWindow(gWindow);

  const int launch = MessageBoxW(
      nullptr,
      L"VoxBridge is installed.\r\n\r\n"
      L"Open it now? It starts the microphone host and opens the VoxBridge window.",
      L"VoxBridge setup complete", MB_YESNO | MB_ICONINFORMATION);
  if (launch == IDYES) {
    ShellExecuteW(nullptr, L"open", (installDir / L"VoxBridge.exe").c_str(), nullptr,
                  installDir.c_str(), SW_SHOWNORMAL);
  }
  CoUninitialize();
  return 0;
}
