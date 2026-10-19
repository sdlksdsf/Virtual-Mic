cmake_minimum_required(VERSION 3.20)
project(VoxBridgeCapture LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(VOXBRIDGE_BUILD_SERVICE "Build the Windows capture service" ON)

add_executable(voxbridge_coretest src/self_test.cpp)
target_include_directories(voxbridge_coretest PRIVATE src)
if(MSVC)
  target_compile_options(voxbridge_coretest PRIVATE /W4 /utf-8 /D_CRT_SECURE_NO_WARNINGS)
else()
  target_compile_options(voxbridge_coretest PRIVATE -Wall -Wextra -O2)
endif()

if(WIN32 AND VOXBRIDGE_BUILD_SERVICE)
  add_executable(VoxBridgeMic WIN32
    src/win_main.cpp
    src/windows_audio.cpp
    res/voxbridge.rc
  )
  target_include_directories(VoxBridgeMic PRIVATE src res)
  target_compile_definitions(VoxBridgeMic PRIVATE UNICODE _UNICODE _CRT_SECURE_NO_WARNINGS)
  target_link_libraries(VoxBridgeMic PRIVATE ole32 oleaut32 uuid propsys wintrust crypt32 shell32)
  if(MSVC)
    target_compile_options(VoxBridgeMic PRIVATE /W3 /utf-8 /permissive-)
    set_property(TARGET VoxBridgeMic PROPERTY
      MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  endif()
  set_target_properties(VoxBridgeMic PROPERTIES OUTPUT_NAME "VoxBridgeMic")
endif()

install(TARGETS voxbridge_coretest RUNTIME DESTINATION .)
if(TARGET VoxBridgeMic)
  install(TARGETS VoxBridgeMic RUNTIME DESTINATION .)
endif()
