# Building Vayu on Windows

This document covers building Vayu on Windows (development and production).

## Prerequisites

- **Visual Studio 2022** with "Desktop development with C++" workload
- **vcpkg** package manager
- **CMake** 3.25+ (included with Visual Studio or install separately)
- **Node.js** v20+ and pnpm

### Installing Prerequisites

1. **Visual Studio 2022**:
   - Download from [visualstudio.com](https://visualstudio.microsoft.com/)
   - Install "Desktop development with C++" workload
   - Ensure "Windows 10/11 SDK" is selected

2. **vcpkg**:
   ```powershell
   git clone https://github.com/Microsoft/vcpkg.git C:\vcpkg
   cd C:\vcpkg
   .\bootstrap-vcpkg.bat
   ```

3. **Node.js and pnpm**:
   ```powershell
   # Install Node.js from nodejs.org
   # Then install pnpm:
   npm install -g pnpm
   ```

## Quick Start

Development:

```powershell
# From project root
.\scripts\build\build-windows.ps1 dev
cd app
pnpm run electron:dev
```

Production:

```powershell
.\scripts\build\build-windows.ps1 prod
# Output:
#   app\release\Vayu Setup *.exe
```

## Build Script Usage

### Basic Commands

```powershell
# Show help
.\scripts\build\build-windows.ps1 -Help

# Development build (engine + app)
.\scripts\build\build-windows.ps1 dev

# Production build (engine + app, packaged)
.\scripts\build\build-windows.ps1 prod
```

### Build Options

| Option | Description |
|--------|-------------|
| `dev` | Development build (Debug mode) |
| `prod` | Production build (Release mode, default) |
| `-SkipEngine` | Skip building the C++ engine |
| `-SkipApp` | Skip building the Electron app |
| `-Clean` | Clean build directories before building |
| `-Help` | Show help message |

### Advanced/CI Options

| Option | Description |
|--------|-------------|
| `-CMakePathParam <path>` | Override CMake executable path |
| `-VcpkgRootParam <path>` | Override vcpkg root directory |
| `-EngineDirParam <path>` | Override engine directory |
| `-AppDirParam <path>` | Override app directory |
| `-ArtifactsDirParam <path>` | Copy built installers to this directory (for CI) |
| `-GeneratorParam <name>` | Override CMake generator (default: "Visual Studio 17 2022") |

### Examples

```powershell
# Full development build
.\scripts\build\build-windows.ps1 dev

# Production build, skip engine (use existing)
.\scripts\build\build-windows.ps1 prod -SkipEngine

# Clean production build
.\scripts\build\build-windows.ps1 prod -Clean

# Build only the engine
.\scripts\build\build-windows.ps1 prod -SkipApp

# CI build with custom paths
.\scripts\build\build-windows.ps1 prod `
  -CMakePathParam "C:\Program Files\CMake\bin\cmake.exe" `
  -VcpkgRootParam "C:\vcpkg" `
  -ArtifactsDirParam ".\artifacts"
```

## Manual Engine Build

If you prefer to build the engine manually:

```powershell
# From project root
cd engine

# Debug build
cmake -B build -A x64 -DCMAKE_BUILD_TYPE=Debug `
  -DCMAKE_TOOLCHAIN_FILE=C:\vcpkg\scripts\buildsystems\vcpkg.cmake
cmake --build build --config Debug

# Release build
cmake -B build -A x64 -DCMAKE_BUILD_TYPE=Release `
  -DCMAKE_TOOLCHAIN_FILE=C:\vcpkg\scripts\buildsystems\vcpkg.cmake
cmake --build build --config Release
```

Or use the unified build script:

```powershell
cd engine
.\scripts\build\build-and-test.sh      # Release build + tests
.\scripts\build\build-and-test.sh -d  # Debug build
```

## Output Files

### Development Build
- Engine binary: `engine\build\Debug\vayu-engine.exe`

### Production Build
- Engine binary: `engine\build\Release\vayu-engine.exe`
- NSIS installer: `app\release\Vayu Setup *.exe`

## Data Directory

- **Development**: `engine\data\`
- **Production**: `%APPDATA%\vayu\`
  - Database: `%APPDATA%\vayu\db\vayu.db`
  - Logs: `%APPDATA%\vayu\logs\`
  - Lock file: `%APPDATA%\vayu\vayu.lock`

## Installation & Uninstallation

### Installing

Run the NSIS installer:
```powershell
.\app\release\Vayu Setup *.exe
```

The installer will:
- Install to `%LOCALAPPDATA%\Programs\vayu\`
- Create Start Menu shortcuts
- Create desktop shortcut (optional)

### Uninstalling

1. **Via Settings**:
   - Settings → Apps → Vayu → Uninstall

2. **Via Control Panel**:
   - Control Panel → Programs → Uninstall a program → Vayu

3. **Manually remove user data** (optional):
   ```powershell
   Remove-Item -Recurse -Force "$env:APPDATA\vayu"
   ```

## Troubleshooting

### vcpkg not found

Set the `VCPKG_ROOT` environment variable:
```powershell
$env:VCPKG_ROOT = "C:\vcpkg"
```

Or use the `-VcpkgRootParam` option:
```powershell
.\scripts\build\build-windows.ps1 prod -VcpkgRootParam "C:\vcpkg"
```

### CMake not found

Ensure CMake is in PATH, or use `-CMakePathParam`:
```powershell
.\scripts\build\build-windows.ps1 prod -CMakePathParam "C:\Program Files\CMake\bin\cmake.exe"
```

### Engine fails to start in packaged app

Ensure the engine binary and required DLLs are included in `app\build\resources\bin\` before packaging.

The build script should handle this automatically, but if issues occur:

1. Verify engine binary exists:
   ```powershell
   Test-Path app\build\resources\bin\vayu-engine.exe
   ```

2. Check for required DLLs (if any):
   ```powershell
   Get-ChildItem app\build\resources\bin\
   ```

### Port 9876 already in use

```powershell
# Find and kill the process
Get-NetTCPConnection -LocalPort 9876 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ }

# Or use the kill-ports script
cd app
pnpm kill-ports
```

### Build fails with "MSBuild not found"

Ensure Visual Studio 2022 is installed with C++ workload. The build script should detect it automatically, but you can specify the generator:

```powershell
.\scripts\build\build-windows.ps1 prod -GeneratorParam "Visual Studio 17 2022"
```

## CI/CD Integration

Example GitHub Actions workflow:

```yaml
- name: Build Windows
  run: |
    pwsh -c ".\scripts\build\build-windows.ps1 prod -ArtifactsDirParam 'artifacts' -VcpkgRootParam 'C:\vcpkg'"
  env:
    VCPKG_ROOT: C:\vcpkg
```

## Resources

- [Engine Building Guide](engine/building.md)
- [App Building Guide](app/building.md)
- [vcpkg Documentation](https://vcpkg.io/)
- [Visual Studio Documentation](https://docs.microsoft.com/en-us/visualstudio/)
