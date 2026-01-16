# Building Vayu on Linux

This document covers building Vayu on Linux (Ubuntu/Debian).

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
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs
npm install -g pnpm
```

## Build Script Usage

The build script supports both development and production builds with various options.

### Basic Commands

```bash
# Show help
./scripts/build/build-linux.sh --help

# Development build (engine + app)
./scripts/build/build-linux.sh dev

# Production build (engine + app, packaged)
./scripts/build/build-linux.sh prod
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
| `-h, --help` | Show help message |

### Examples

```bash
# Full development build
./scripts/build/build-linux.sh dev

# Production build, skip engine (use existing)
./scripts/build/build-linux.sh prod --skip-engine

# Clean production build
./scripts/build/build-linux.sh prod --clean

# Build only the engine
./scripts/build/build-linux.sh prod --skip-app

# CI build with artifact collection
./scripts/build/build-linux.sh prod --artifacts ./dist
```

## Quick Start

Development:

```bash
./scripts/build/build-linux.sh dev
cd app
pnpm run electron:dev
```

Production:

```bash
./scripts/build/build-linux.sh prod
# Output: app/release/Vayu-*.AppImage and/or *.deb
```

## Manual Engine Build

If you prefer to build the engine manually:

```bash
cd engine

# Debug build
cmake -B build -GNinja -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
cmake --build build

# Release build
cmake -B build -GNinja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
cmake --build build
```

Or use the unified build script:

```bash
cd engine
./scripts/build/build-and-test.sh      # Release build + tests
./scripts/build/build-and-test.sh -d  # Debug build
```

## Output Files

### Development Build
- Engine binary: `engine/build/vayu-engine`

### Production Build
- Engine binary: `engine/build/vayu-engine` (or `build-release/` if using separate dir)
- AppImage: `app/release/Vayu-*.AppImage`
- Debian package: `app/release/vayu-client_*.deb`

## Data Directory

- **Development**: `engine/data/`
- **Production**: `~/.config/vayu/`
  - Database: `~/.config/vayu/db/vayu.db`
  - Logs: `~/.config/vayu/logs/`
  - Lock file: `~/.config/vayu/vayu.lock`

## Installation & Uninstallation

### Installing

**AppImage:**
```bash
chmod +x 'Vayu-*.AppImage'
./'Vayu-*.AppImage'
```

**Debian/Ubuntu (.deb):**
```bash
sudo dpkg -i vayu-client_*.deb
# Or with apt (handles dependencies automatically):
sudo apt install ./vayu-client_*.deb
```

### Uninstalling

**AppImage:**
```bash
# Simply delete the AppImage file
rm 'Vayu-*.AppImage'

# Optionally remove user data:
rm -rf ~/.config/vayu
```

**Debian/Ubuntu (.deb):**
```bash
# Uninstall the package
sudo apt remove vayu-client
# Or:
sudo dpkg -r vayu-client

# To also remove configuration files:
sudo apt purge vayu-client

# Optionally remove user data:
rm -rf ~/.config/vayu
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
chmod +x Vayu-*.AppImage
./Vayu-*.AppImage
```

### Port 9876 already in use

```bash
# Find and kill the process
lsof -i :9876
kill <PID>

# Or use the kill-ports script
cd app
pnpm kill-ports
```

### Engine fails to start

1. Check if engine binary exists and is executable:
   ```bash
   ls -la engine/build/vayu-engine
   chmod +x engine/build/vayu-engine
   ```

2. Check engine logs:
   ```bash
   tail -f ~/.config/vayu/logs/vayu.log
   ```

## CI/CD Integration

The build script supports CI environments with the `--artifacts` flag:

```yaml
# Example GitHub Actions
- name: Build Linux
  run: |
    ./scripts/build/build-linux.sh prod --artifacts ./artifacts
  env:
    VCPKG_ROOT: ${{ github.workspace }}/vcpkg
```

## Resources

- [Engine Building Guide](engine/building.md)
- [App Building Guide](app/building.md)
- [vcpkg Documentation](https://vcpkg.io/)
