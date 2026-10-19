// VoxBridge launcher (Windows).
//
// Starts the local host (node.exe + standalone/server.js) and opens the app
// window. A second launch focuses the running instance instead of starting a
// duplicate receiver on port 8720.

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shlobj.h>
#include <shellapi.h>
#include <string>
#include <filesystem>

namespace fs = std::filesystem;

static bool portOpen(unsigned short port) {
  WSADATA data;
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return false;
  SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (sock == INVALID_SOCKET) return false;
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  timeval timeout{0, 400000};
  setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
  const bool open = connect(sock, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0;
  closesocket(sock);
  WSACleanup();
  return open;
}

static std::wstring knownFolder(REFKNOWNFOLDERID id) {
  PWSTR path = nullptr;
  std::wstring result;
  if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_CREATE, nullptr, &path)) && path) {
    result = path;
    CoTaskMemFree(path);
  }
  return result;
}

static void openUrl(const std::wstring& url) {
  ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  wchar_t self[MAX_PATH * 2];
  if (!GetModuleFileNameW(nullptr, self, static_cast<DWORD>(std::size(self)))) return 1;
  const fs::path dir = fs::path(self).parent_path();
  const fs::path node = dir / L"node.exe";
  const fs::path server = dir / L"app" / L"standalone" / L"server.js";
  const fs::path service = dir / L"service" / L"VoxBridgeMic.exe";

  if (!fs::exists(node) || !fs::exists(server)) {
    MessageBoxW(nullptr,
                L"VoxBridge could not find its application files.\r\n\r\n"
                L"Reinstall VoxBridge from the official download page.",
                L"VoxBridge could not start", MB_ICONERROR | MB_OK);
    return 1;
  }

  if (portOpen(47800)) {
    openUrl(L"http://127.0.0.1:47800/");
    return 0;
  }

  const std::wstring localAppData = knownFolder(FOLDERID_LocalAppData);
  if (!localAppData.empty()) {
    const std::wstring dataDir = localAppData + L"\\VoxBridge";
    SetEnvironmentVariableW(L"VOXBRIDGE_DATA", dataDir.c_str());
  }
  if (fs::exists(service)) SetEnvironmentVariableW(L"VOXBRIDGE_SERVICE", service.c_str());
  SetEnvironmentVariableW(L"VOXBRIDGE_LAUNCHER", (dir / L"VoxBridge.exe").c_str());

  std::wstring command = L"\"" + node.wstring() + L"\" \"" + server.wstring() + L"\" --open";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, FALSE,
                      CREATE_NO_WINDOW, nullptr, dir.c_str(), &startup, &process)) {
    const DWORD error = GetLastError();
    wchar_t message[512];
    swprintf_s(message, L"VoxBridge could not start its audio host (error %lu).\r\n\r\n"
                         L"Check that antivirus software did not block node.exe.",
               error);
    MessageBoxW(nullptr, message, L"VoxBridge could not start", MB_ICONERROR | MB_OK);
    return 1;
  }
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return 0;
}
