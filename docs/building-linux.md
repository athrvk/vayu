# Building Vayu on Linux

This document covers building Vayu Desktop on Linux (Ubuntu/Debian).

## Prerequisites

```bash
sudo apt update
sudo apt install build-essential cmake ninja-build git curl

# Install vcpkg
git clone https://github.com/Microsoft/vcpkg.git ~/vcpkg
cd ~/vcpkg
./bootstrap-vcpkg.sh
sudo ln -s $(pwd)/vcpkg /usr/local/bin/vcpkg
export VCPKG_ROOT=~/vcpkg

# Node and pnpm
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install nodejs
npm install -g pnpm
```

## Build Script Usage

The build script supports both development and production builds with various options.

### Basic Commands

```bash
# Show help
./scripts/build-linux.sh --help

# Development build (engine + app)
./scripts/build-linux.sh dev

# Production build (engine + app, packaged)
./scripts/build-linux.sh prod
```

### Build Options

| Option | Description |
|--------|-------------|
| `dev` | Development build with debug symbols |
| `prod` | Production build, optimized and packaged (default) |
| `--skip-engine` | Skip building the C++ engine |
| `--skip-app` | Skip building the Electron app |
| `--clean` | Clean build directory before building |
| `--vcpkg-root PATH` | Override vcpkg root directory |
| `--artifacts PATH` | Copy build artifacts to directory (for CI) |

### Examples

```bash
# Full development build
./scripts/build-linux.sh dev

# Production build, skip engine (use existing)
./scripts/build-linux.sh prod --skip-engine

# Clean production build
./scripts/build-linux.sh prod --clean

# Build only the engine
./scripts/build-linux.sh prod --skip-app

# CI build with artifact collection
./scripts/build-linux.sh prod --artifacts ./dist
```

## Quick Start

Development:

```bash
./scripts/build-linux.sh dev
cd app
pnpm run electron:dev
```

Production:

```bash
./scripts/build-linux.sh prod
# Output: app/release/Vayu Desktop-*.AppImage and/or *.deb
```

## Manual Engine Build

```bash
cd engine
cmake -B build -GNinja -DCMAKE_BUILD_TYPE=Debug
cmake --build build
```

For release:

```bash
cd engine
cmake -B build-release -GNinja -DCMAKE_BUILD_TYPE=Release
cmake --build build-release
```

## Output Files

### Development Build
- Engine binary: `engine/build/vayu-engine`

### Production Build
- Engine binary: `engine/build-release/vayu-engine`
- AppImage: `app/release/Vayu Desktop-*.AppImage`
- Debian package: `app/release/Vayu Desktop-*.deb`
- RPM package: `app/release/Vayu Desktop-*.rpm` (if fpm is available)

## Notes

- Data directory: `~/.config/vayu-desktop`
- Logs directory: `~/.config/vayu-desktop/logs`
- CI: Use `--artifacts` flag to collect build outputs

## Installation & Uninstallation

### Installing

**AppImage:**
```bash
chmod +x 'Vayu Desktop-0.1.0.AppImage'
./'Vayu Desktop-0.1.0.AppImage'
```

**Debian/Ubuntu (.deb):**
```bash
sudo dpkg -i vayu-desktop_0.1.0_amd64.deb
# Or with apt (handles dependencies automatically):
sudo apt install ./vayu-desktop_0.1.0_amd64.deb
```

### Uninstalling

**AppImage:**
```bash
# Simply delete the AppImage file
rm 'Vayu Desktop-0.1.0.AppImage'

# Optionally remove user data:
rm -rf ~/.config/vayu-desktop
```

**Debian/Ubuntu (.deb):**
```bash
# Uninstall the package
sudo apt remove vayu-desktop
# Or:
sudo dpkg -r vayu-desktop

# To also remove configuration files:
sudo apt purge vayu-desktop

# Optionally remove user data:
rm -rf ~/.config/vayu-desktop
```

## Troubleshooting

### vcpkg not found
Make sure `VCPKG_ROOT` is set or vcpkg is in your PATH:
```bash
export VCPKG_ROOT=~/vcpkg
export PATH=$VCPKG_ROOT:$PATH
```

### Missing build dependencies
```bash
sudo apt install build-essential cmake ninja-build pkg-config libssl-dev
```

### AppImage not running
Make sure it's executable:
```bash
chmod +x Vayu-Desktop-*.AppImage
./Vayu-Desktop-*.AppImage
```
