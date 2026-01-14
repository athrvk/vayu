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

# Node and pnpm
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install nodejs
npm install -g pnpm
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
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
```

## Notes

- Engine binary: `engine/build/vayu-engine`
- Data directory: `~/.config/vayu-desktop`
- CI: Use `artifacts` upload to collect AppImage or .deb
