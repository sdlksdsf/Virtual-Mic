// VoxBridge uninstaller (Windows).
//
// Removes the program directory, shortcuts and the Apps list entry. Personal
// settings in %LOCALAPPDATA%\VoxBridge and recordings are kept.

#include <windows.h>
#include <shlobj.h>
#include <shellapi.h>
#include <string>
#include <filesystem>

namespace fs = std::filesystem;

static std::wstring knownFolder(REFKNOWNFOLDERID id) {
  PWSTR path = nullptr;
  std::wstring result;
  if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_CREATE, nullptr, &path)) && path) {
    result = path;
    CoTaskMemFree(path);
  }
  return result;
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  wchar_t self[MAX_PATH * 2];
  if (!GetModuleFileNameW(nullptr, self, static_cast<DWORD>(std::size(self)))) return 1;
  const fs::path dir = fs::path(self).parent_path();

  const int answer = MessageBoxW(
      nullptr,
      L"Remove VoxBridge from this PC?\r\n\r\n"
      L"The app and its shortcuts will be deleted. Your settings and any recordings in Music are kept.",
      L"Uninstall VoxBridge", MB_YESNO | MB_ICONQUESTION);
  if (answer != IDYES) {
    CoUninitialize();
    return 0;
  }

  std::error_code ec;
  const std::wstring programs = knownFolder(FOLDERID_Programs);
  const std::wstring desktop = knownFolder(FOLDERID_Desktop);
  if (!programs.empty()) fs::remove(fs::path(programs) / L"VoxBridge.lnk", ec);
  if (!desktop.empty()) fs::remove(fs::path(desktop) / L"VoxBridge.lnk", ec);

  RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VoxBridge");
  RegDeleteKeyValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", L"VoxBridge");

  const std::wstring command = L"/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"" + dir.wstring() + L"\"";
  ShellExecuteW(nullptr, L"open", L"cmd.exe", command.c_str(), nullptr, SW_HIDE);

  MessageBoxW(nullptr,
              L"VoxBridge has been removed.\r\n\r\n"
              L"If it still appears in Settings > Apps, refresh the list once.",
              L"VoxBridge uninstalled", MB_ICONINFORMATION | MB_OK);
  CoUninitialize();
  return 0;
}
