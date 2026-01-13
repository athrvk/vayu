# Building Vayu Desktop - Cross-Platform Guide

This guide covers building Vayu Desktop for all supported platforms: macOS, Windows, and Linux.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Platform-Specific Guides](#platform-specific-guides)
- [Build Scripts](#build-scripts)

## Prerequisites

### All Platforms

- **Node.js** v18+ with pnpm
- **CMake** v3.25+
- **vcpkg** package manager
- **Git**

### macOS

- **Xcode Command Line Tools**
- **Homebrew** (recommended)

```bash
xcode-select --install
brew install cmake ninja vcpkg pnpm
```

### Windows

- **Visual Studio 2022** with C++ development tools
- **vcpkg** for Windows
- **Git Bash** or **WSL2** (for running bash scripts)

```powershell
# Install vcpkg
git clone https://github.com/Microsoft/vcpkg.git C:\vcpkg
cd C:\vcpkg
.\bootstrap-vcpkg.bat

# Add to PATH
setx PATH "%PATH%;C:\vcpkg"

# Install Node.js and pnpm
winget install OpenJS.NodeJS
npm install -g pnpm
```

### Linux (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install build-essential cmake ninja-build git curl

# Install vcpkg
git clone https://github.com/Microsoft/vcpkg.git ~/vcpkg
cd ~/vcpkg
./bootstrap-vcpkg.sh
sudo ln -s $(pwd)/vcpkg /usr/local/bin/vcpkg

# Install Node.js and pnpm
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install nodejs
npm install -g pnpm
```

## Quick Start

### Development Mode

```bash
# Clone repository
git clone https://github.com/athrvk/vayu.git
cd vayu

# macOS
./scripts/build-macos.sh dev

# Linux
./scripts/build-linux.sh dev

# Windows (PowerShell)
.\scripts\build-windows.ps1 dev

# Start development (after build completes)
cd app
pnpm run electron:dev
```

### Production Build

```bash
# macOS
./scripts/build-macos.sh prod
# Output: app/release/Vayu Desktop-*.dmg

# Linux
./scripts/build-linux.sh prod
# Output: app/release/Vayu Desktop-*.AppImage or *.deb

# Windows (PowerShell)
.\scripts\build-windows.ps1 prod
# Output: app/release/Vayu Desktop Setup *.exe
```

## Platform-Specific Guides

### macOS

See [building-macos.md](./building-macos.md) for detailed macOS-specific instructions.

**Key Points:**
- Universal binary support (Apple Silicon + Intel)
- Code signing and notarization for distribution
- DMG installer creation

**Manual Engine Build:**
```bash
./scripts/build-engine-macos.sh
```

### Windows

**Development Setup:**

1. Install Visual Studio 2022 with "Desktop development with C++" workload
2. Install vcpkg and add to PATH
3. Clone repository
4. Run in Git Bash or WSL2:

```bash
./scripts/build-app-dev.sh
cd app
pnpm run electron:dev
```

**Production Build:**

```bash
# In Git Bash or WSL2
./scripts/build-app-prod.sh
```

**Manual Engine Build:**
```bash
./scripts/build-engine-windows.sh
```

**Important Notes:**
- Engine binary: `engine/build/Release/vayu-engine.exe`
- Data directory: `%APPDATA%/vayu-desktop`
- NSIS installer is created for distribution

### Linux

**Development Setup:**

```bash
./scripts/build-app-dev.sh
cd app
pnpm run electron:dev
```

**Production Build:**

```bash
./scripts/build-app-prod.sh
```

**Manual Engine Build:**
```bash
./scripts/build-engine-linux.sh
```

**Important Notes:**
- Engine binary: `engine/build/vayu-engine`
- Data directory: `~/.config/vayu-desktop`
- AppImage and .deb packages are created

## Build Scripts

### Platform-Specific Scripts

Vayu provides a single build script for each platform that handles both development and production builds.

#### `build-macos.sh`

**Usage:**
```bash
./scripts/build-macos.sh [dev|prod]
```

**Features:**
- Auto-detects macOS architecture (Apple Silicon or Intel)
- Builds C++ engine with CMake and vcpkg
- Compiles TypeScript and builds React app
- In prod mode: Creates universal DMG installer
- In dev mode: Sets up for `pnpm run electron:dev`

**Example:**
```bash
# Development build
./scripts/build-macos.sh dev
cd app && pnpm run electron:dev

# Production build
./scripts/build-macos.sh prod
# Output: app/release/Vayu Desktop-*.dmg
```

#### `build-linux.sh`

**Usage:**
```bash
./scripts/build-linux.sh [dev|prod]
```

**Features:**
- Auto-detects Linux architecture (x64 or ARM64)
- Builds C++ engine with CMake and vcpkg
- Compiles TypeScript and builds React app
- In prod mode: Creates AppImage and .deb packages
- In dev mode: Sets up for `pnpm run electron:dev`

**Example:**
```bash
# Development build
./scripts/build-linux.sh dev
cd app && pnpm run electron:dev

# Production build
./scripts/build-linux.sh prod
# Output: app/release/Vayu Desktop-*.AppImage and *.deb
```

#### `build-windows.ps1`

**Usage (PowerShell):**
```powershell
.\scripts\build-windows.ps1 [dev|prod]
```

**Features:**
- Auto-detects Windows architecture (x64 or ARM64)
- Builds C++ engine with Visual Studio 2022
- Compiles TypeScript and builds React app
- In prod mode: Creates NSIS installer
- In dev mode: Sets up for `pnpm run electron:dev`

**Example:**
```powershell
# Development build
.\scripts\build-windows.ps1 dev
cd app
pnpm run electron:dev

# Production build
.\scripts\build-windows.ps1 prod
# Output: app\release\Vayu Desktop Setup *.exe
```

### Build Modes

#### Development (`dev`)

- Builds engine in **Debug** mode with debug symbols
- Engine built to `engine/build/`
- Only compiles TypeScript (no packaging)
- Faster build times
- Includes debugging information
- Instructions to run with `pnpm run electron:dev`

#### Production (`prod`)

- Builds engine in **Release** mode with optimizations
- Engine built to `engine/build-release/`
- Full TypeScript compilation and React build
- Packages with electron-builder
- Creates platform-specific installers
- Optimized for distribution

## File Paths

### Development Mode

| Platform | Engine Binary | Data Directory |
|----------|--------------|----------------|
| macOS | `../engine/build/vayu-engine` | `../engine/data/` |
| Windows | `../engine/build/Release/vayu-engine.exe` | `../engine/data/` |
| Linux | `../engine/build/vayu-engine` | `../engine/data/` |

### Production Mode

| Platform | Engine Binary | Data Directory |
|----------|--------------|----------------|
| macOS | `Contents/Resources/bin/vayu-engine` | `~/Library/Application Support/vayu-desktop` |
| Windows | `resources/bin/vayu-engine.exe` | `%APPDATA%/vayu-desktop` |
| Linux | `resources/bin/vayu-engine` | `~/.config/vayu-desktop` |

## Troubleshooting

### vcpkg not found

**Solution:**
```bash
# Ensure vcpkg is in PATH
which vcpkg  # Unix
where vcpkg  # Windows

# If not found, add to PATH or use full path
```

### CMake configuration fails

**macOS:**
```bash
brew install cmake ninja
```

**Windows:**
```powershell
winget install Kitware.CMake
```

**Linux:**
```bash
sudo apt install cmake ninja-build
```

### Visual Studio not found (Windows)

**Error:** "No CMAKE_CXX_COMPILER could be found"

**Solution:**
1. Install Visual Studio 2022
2. Select "Desktop development with C++"
3. Restart terminal

### Permission denied (Linux)

**Error:** Cannot create directory

**Solution:**
```bash
chmod +x scripts/*.sh
```

### Engine fails to start

**Check logs:**
- macOS: `~/Library/Application Support/vayu-desktop/logs/`
- Windows: `%APPDATA%/vayu-desktop/logs/`
- Linux: `~/.config/vayu-desktop/logs/`

## CI/CD

### GitHub Actions Example

```yaml
name: Build

on: [push, pull_request]

jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    
    runs-on: ${{ matrix.os }}
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install pnpm
        run: npm install -g pnpm
      
      - name: Install vcpkg
        run: |
          git clone https://github.com/Microsoft/vcpkg.git
          ./vcpkg/bootstrap-vcpkg.sh  # or .bat on Windows
      
      - name: Build
        run: ./scripts/build-app-prod.sh
      
      - name: Upload artifacts
        uses: actions/upload-artifact@v3
        with:
          name: vayu-${{ matrix.os }}
          path: app/release/*
```

## Distribution

### Code Signing

**macOS:**
```bash
export APPLE_ID="your@email.com"
export APPLE_ID_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="XXXXXXXXXX"

./scripts/build-app-prod.sh
```

**Windows:**
- Sign with SignTool and a code signing certificate
- Configure in electron-builder.json

**Linux:**
- No code signing required
- GPG signing recommended for .deb packages

## Resources

- [Electron Documentation](https://www.electronjs.org/docs)
- [electron-builder](https://www.electron.build/)
- [vcpkg Documentation](https://vcpkg.io/)
- [CMake Documentation](https://cmake.org/documentation/)

## Getting Help

For platform-specific issues, see:
- [macOS Build Guide](./building-macos.md)
- [Troubleshooting Guide](./troubleshooting.md)

For general help:
- [GitHub Issues](https://github.com/athrvk/vayu/issues)
- [Discussions](https://github.com/athrvk/vayu/discussions)
