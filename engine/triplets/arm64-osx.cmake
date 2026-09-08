# Overlay of vcpkg's stock arm64-osx, adding the one thing it leaves to the
# host: the deployment target. Without it every port - and everything their
# headers inline into the engine - is built against the SDK of whatever macOS
# the builder happens to run, so a binary produced on a macOS 26 runner
# references libc++ symbols that do not exist on the macOS 13 floor Vayu
# documents and dies at launch with "Symbol not found". Keep in step with
# VAYU_MACOS_DEPLOYMENT_TARGET in ../CMakeLists.txt.
set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)

set(VCPKG_CMAKE_SYSTEM_NAME Darwin)
set(VCPKG_OSX_ARCHITECTURES arm64)
set(VCPKG_OSX_DEPLOYMENT_TARGET 13.0)
