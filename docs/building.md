# Building Vayu from Source

**Version:** 1.0  
**Last Updated:** January 2, 2026

---

## Prerequisites

### All Platforms

- **Git** - Version control
- **CMake** - ≥3.25
- **Ninja** - Build system (optional but recommended)
- **Node.js** - ≥20 LTS
- **pnpm** - ≥8.x

### macOS

```bash
# Install Xcode Command Line Tools
xcode-select --install

# Install dependencies via Homebrew
brew install cmake ninja node
npm install -g pnpm

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

# Install Node.js (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pnpm

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
winget install OpenJS.NodeJS.LTS
winget install Git.Git

# Install pnpm
npm install -g pnpm

# Install vcpkg
git clone https://github.com/microsoft/vcpkg.git C:\vcpkg
C:\vcpkg\bootstrap-vcpkg.bat
$env:VCPKG_ROOT = "C:\vcpkg"
```

---

## Clone Repository

```bash
git clone https://github.com/vayu/vayu.git
cd vayu
```

---

## Build Engine (C++)

### Install C++ Dependencies

```bash
cd engine

# vcpkg will automatically install dependencies via vcpkg.json
```

### Configure Build

```bash
# Debug build
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake

# Release build
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

### Build

```bash
# Build all targets
cmake --build build

# Build specific targets
cmake --build build --target vayu-cli
cmake --build build --target vayu-engine
```

### Run Tests

```bash
ctest --test-dir build --output-on-failure
```

### Output Binaries

```
engine/build/
├── vayu-cli        # CLI tool
└── vayu-engine     # Daemon for Electron app
```

---

## Build App (Electron)

### Install Dependencies

```bash
cd app
pnpm install
```

### Development Mode

```bash
# Start Vite dev server + Electron
pnpm dev
```

This will:
1. Start Vite on `http://localhost:5173`
2. Launch Electron loading from Vite
3. Enable hot module replacement (HMR)

### Build for Production

```bash
# Build renderer (React)
pnpm build

# Package for current platform
pnpm package

# Build and package
pnpm dist
```

### Platform-Specific Builds

```bash
# macOS (Universal - both Intel and Apple Silicon)
pnpm dist:mac

# macOS (Intel only)
pnpm dist:mac:x64

# macOS (Apple Silicon only)
pnpm dist:mac:arm64

# Windows
pnpm dist:win

# Linux
pnpm dist:linux
```

### Output Artifacts

```
app/dist/
├── mac-universal/
│   └── Vayu.app
├── Vayu-0.1.0-universal.dmg
├── Vayu-0.1.0-universal.zip
└── latest-mac.yml
```

---

## Full Build Script

### macOS/Linux

```bash
#!/bin/bash
set -e

# Build engine
echo "Building engine..."
cd engine
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
cmake --build build

# Copy engine to app resources
mkdir -p ../app/resources/bin
cp build/vayu-engine ../app/resources/bin/

# Build app
echo "Building app..."
cd ../app
pnpm install
pnpm dist

echo "Build complete!"
```

### Windows (PowerShell)

```powershell
# Build engine
Write-Host "Building engine..."
Set-Location engine
cmake -B build -G Ninja `
  -DCMAKE_BUILD_TYPE=Release `
  -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT\scripts\buildsystems\vcpkg.cmake"
cmake --build build

# Copy engine to app resources
New-Item -ItemType Directory -Force -Path ..\app\resources\bin
Copy-Item build\vayu-engine.exe ..\app\resources\bin\

# Build app
Write-Host "Building app..."
Set-Location ..\app
pnpm install
pnpm dist

Write-Host "Build complete!"
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

### Example

```bash
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug \
  -DVAYU_BUILD_TESTS=ON \
  -DVAYU_USE_ASAN=ON \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

---

## Development Workflow

### Engine Development

```bash
cd engine

# Build in debug mode
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
cmake --build build

# Run CLI
./build/vayu-cli run ../test-data/simple-get.json

# Run tests
ctest --test-dir build -V
```

### App Development

```bash
cd app

# Start development server
pnpm dev

# The app will hot-reload on file changes
```

### End-to-End Testing

```bash
# Terminal 1: Run engine manually
./engine/build/vayu-engine

# Terminal 2: Run app in dev mode
cd app && pnpm dev
```

---

## Troubleshooting

### CMake can't find vcpkg

```
CMake Error: Could not find toolchain file
```

**Solution:**
```bash
export VCPKG_ROOT=~/.vcpkg
```

---

### libcurl SSL errors on macOS

```
curl: (60) SSL certificate problem
```

**Solution:**
```bash
# Use system SSL
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCURL_USE_SECTRANSPORT=ON \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

---

### Electron app shows white screen

**Solution:**
1. Check DevTools console (`Cmd+Opt+I`)
2. Ensure engine binary is in `app/resources/bin/`
3. Check engine process is running: `ps aux | grep vayu-engine`

---

### Permission denied on macOS

```
"Vayu.app" is damaged and can't be opened
```

**Solution:**
```bash
xattr -cr /Applications/Vayu.app
```

---

### Build fails on Apple Silicon

```
error: building for macOS-arm64 but attempting to link with file built for macOS-x86_64
```

**Solution:**
```bash
# Clean build
rm -rf build
cmake -B build -G Ninja \
  -DCMAKE_OSX_ARCHITECTURES="arm64" \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

---

## IDE Setup

### VS Code (Recommended)

Install extensions:
- C/C++ (Microsoft)
- CMake Tools
- ESLint
- Prettier

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

## Continuous Integration

See `.github/workflows/ci.yml` for the full CI configuration.

### Local CI Simulation

```bash
# Run same checks as CI
./scripts/ci-local.sh
```

---

*← [Getting Started](getting-started.md) | [Architecture](architecture.md) →*
