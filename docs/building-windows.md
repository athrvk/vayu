# Building Vayu on Windows

This document covers building Vayu on Windows (development and production).

## Prerequisites

- Visual Studio 2022 with "Desktop development with C++"
- vcpkg
- CMake
- Node.js (v18+) and pnpm

## Quick Start

Development:

```powershell
# From project root
.\scripts\build-windows.ps1 dev
cd app
pnpm run electron:dev
```

Production:

```powershell
.\scripts\build-windows.ps1 prod
# Output:
#   app\release\Vayu Setup *.exe
```

## Manual Engine Build

```powershell
# From project root
cd engine
cmake -B build -A x64 -DCMAKE_BUILD_TYPE=Debug
cmake --build build --config Debug
```

## Notes about the Windows build script

`scripts\build-windows.ps1` accepts optional parameters to support CI and custom paths:

- `-CMakePathParam <path>` — path to `cmake.exe`
- `-VcpkgRootParam <path>` — path to vcpkg root
- `-EngineDirParam <path>` — custom engine directory
- `-AppDirParam <path>` — custom app directory
- `-ArtifactsDirParam <path>` — copy built installers to this directory (useful in CI)

Example usage in CI when vcpkg is installed to a custom location:

```yaml
- name: Package Windows
  run: |
    pwsh -c "./scripts/build-windows.ps1 prod -SkipEngine -ArtifactsDirParam 'artifacts' -AppDirParam 'app' -CMakePathParam 'C:\\Program Files\\CMake\\bin\\cmake.exe' -VcpkgRootParam 'C:\\vcpkg'"
```

## Troubleshooting

- If the engine fails to start in the packaged app, ensure the engine binary and required DLLs are included in `app/build/resources/bin/` before packaging.
- Use `-ArtifactsDirParam` to collect installers/artifacts in CI.
