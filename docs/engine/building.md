# Building Vayu Engine from Source

**Version:** 1.0  
**Last Updated:** January 2, 2026

---

## Prerequisites

### All Platforms

- **Git** - Version control
- **CMake** - ≥3.25
- **Ninja** - Build system (optional but recommended)

### macOS

```bash
# Install Xcode Command Line Tools
xcode-select --install

# Install dependencies via Homebrew
brew install cmake ninja

# Install vcpkg
git clone https://github.com/microsoft/vcpkg.git ~/.vcpkg
~/.vcpkg/bootstrap-vcpkg.sh
export VCPKG_ROOT=~/.vcpkg
```

### Linux (Ubuntu/Debian)

```bash
# Install build tools
sudo apt update
sudo apt install -y build-essential cmake ninja-build git curl

# Install vcpkg
git clone https://github.com/microsoft/vcpkg.git ~/.vcpkg
~/.vcpkg/bootstrap-vcpkg.sh
export VCPKG_ROOT=~/.vcpkg
```

### Windows

```powershell
# Install via winget
winget install Kitware.CMake
winget install Ninja-build.Ninja
winget install Git.Git

# Install vcpkg
git clone https://github.com/microsoft/vcpkg.git C:\vcpkg
C:\vcpkg\bootstrap-vcpkg.bat
$env:VCPKG_ROOT = "C:\vcpkg"
```

---

## Clone Repository

```bash
git clone https://github.com/vayu/vayu.git
cd vayu/engine
```

---

## Install C++ Dependencies

Dependencies are specified in `vcpkg.json`. vcpkg will automatically install them:

```bash
# vcpkg reads vcpkg.json and installs dependencies
# (handled automatically by CMake during configure)
```

---

## Configure Build

### Debug Build

```bash
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

### Release Build

```bash
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

---

## Build Targets

### Build All

```bash
cmake --build build
```

### Build CLI Tool Only

```bash
cmake --build build --target vayu-cli
```

### Build Engine Daemon Only

```bash
cmake --build build --target vayu-engine
```

### Build Tests Only

```bash
cmake --build build --target vayu_tests
```

---

## Run Tests

```bash
# Run all tests
ctest --test-dir build --output-on-failure

# Run specific test
ctest --test-dir build --output-on-failure -R HttpClientTest
```

---

## Output Binaries

After building, binaries are located in:

```
engine/build/
├── vayu-cli        # CLI tool for single requests
├── vayu-engine     # Daemon for Electron app
└── vayu_tests      # Test executable
```

---

## CMake Options

| Option | Default | Description |
|--------|---------|-------------|
| `CMAKE_BUILD_TYPE` | `Debug` | `Debug`, `Release`, `RelWithDebInfo` |
| `VAYU_BUILD_TESTS` | `ON` | Build test suite |
| `VAYU_BUILD_CLI` | `ON` | Build CLI tool |
| `VAYU_BUILD_ENGINE` | `ON` | Build daemon |
| `VAYU_USE_ASAN` | `OFF` | Enable AddressSanitizer |
| `VAYU_USE_TSAN` | `OFF` | Enable ThreadSanitizer |

### Example: Debug with ASAN

```bash
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug \
  -DVAYU_USE_ASAN=ON \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
cmake --build build
```

---

## Development Workflow

### Build Engine

```bash
cd engine

# Configure debug build
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake

# Build
cmake --build build

# Run tests
ctest --test-dir build --output-on-failure
```

### Rebuild After Changes

```bash
cd engine/build
ninja  # Faster incremental rebuild
```

---

## Troubleshooting

### CMake Can't Find vcpkg

```
CMake Error: Could not find toolchain file
```

**Solution:**
```bash
export VCPKG_ROOT=~/.vcpkg
```

---

### libcurl SSL Errors on macOS

```
curl: (60) SSL certificate problem
```

**Solution:**
```bash
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCURL_USE_SECTRANSPORT=ON \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

---

### Build Fails on Apple Silicon

```
error: building for macOS-arm64 but attempting to link with file built for macOS-x86_64
```

**Solution:**
```bash
rm -rf build
cmake -B build -G Ninja \
  -DCMAKE_OSX_ARCHITECTURES="arm64" \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

---

## IDE Setup

### VS Code

Install extensions:
- C/C++ (Microsoft)
- CMake Tools

`.vscode/settings.json`:
```json
{
  "cmake.configureArgs": [
    "-DCMAKE_TOOLCHAIN_FILE=${env:VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake"
  ],
  "cmake.generator": "Ninja"
}
```

### CLion

1. Open `engine/` as CMake project
2. Settings → Build → CMake:
   - CMake options: `-DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake`
   - Generator: Ninja

---

*← [Getting Started](../getting-started.md) | [API Reference](api-reference.md) →*
