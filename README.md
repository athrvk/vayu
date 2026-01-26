# Vayu

**High-Performance API Testing Platform**

[![Latest Release](https://img.shields.io/badge/release-v0.1.1-green.svg)](https://github.com/athrvk/vayu/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0%20%26%20Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/athrvk/vayu/releases)

[![GitHub stars](https://img.shields.io/github/stars/athrvk/vayu.svg?style=social&label=Star)](https://github.com/athrvk/vayu)
[![GitHub forks](https://img.shields.io/github/forks/athrvk/vayu.svg?style=social&label=Fork)](https://github.com/athrvk/vayu/fork)
[![GitHub issues](https://img.shields.io/github/issues/athrvk/vayu)](https://github.com/athrvk/vayu/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/athrvk/vayu?label=pull%20requests)](https://github.com/athrvk/vayu/pulls)

![C++](https://img.shields.io/badge/C++-20-blue.svg?logo=cplusplus)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg?logo=typescript)
![React](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react)
![Electron](https://img.shields.io/badge/Electron-28-47848F.svg?logo=electron)

## Overview

Vayu combines the ease of use of API design tools like Postman with the raw performance of high-throughput load testing tools. Build and debug requests visually, then run the same tests at scale—all in one tool.

Vayu uses a **sidecar architecture** that separates the user interface from the execution engine:

- **The Manager** (Electron + React): Provides a modern UI for building requests, managing collections, and viewing results
- **The Engine** (C++): A high-performance daemon capable of executing thousands of requests per second

The Manager communicates with the Engine via a local HTTP API on port 9876, allowing each component to be optimized for its specific purpose.

## Features

- **High Performance** - C++ engine optimized for maximum throughput
- **Request Management** - Organize requests into collections with folder hierarchy
- **Load Testing** - Run load tests with real-time metrics streaming
- **Environment Variables** - Manage variables across collections and environments
- **Test Scripting** - QuickJS-based scripting engine compatible with Postman's `pm.test()` syntax
- **Privacy First** - 100% local execution, no cloud sync required
- **Cross Platform** - macOS, Windows, and Linux support

## 📦 Download

**Version 0.1.1** is now available! Download the installer for your platform:

- **Windows**: [Vayu Setup 0.1.1.exe](https://github.com/athrvk/vayu/releases/download/v0.1.1/Vayu.Setup.0.1.1.exe)
- **macOS**: [Vayu-0.1.1-universal.dmg](https://github.com/athrvk/vayu/releases/download/v0.1.1/Vayu-0.1.1-universal.dmg)
- **Linux**: [Vayu-0.1.1-x86_64.AppImage](https://github.com/athrvk/vayu/releases/download/v0.1.1/Vayu-0.1.1-x86_64.AppImage)

[View all releases →](https://github.com/athrvk/vayu/releases)

## Quick Start

### Prerequisites

- **C++ Engine**: CMake 3.25+, C++20 compiler, vcpkg
- **Electron App**: Node.js ≥ 20 LTS, pnpm ≥ 10

### Building from Source

Clone the repository:

```bash
git clone https://github.com/athrvk/vayu.git
cd vayu
```

Build and run (all platforms):

```bash
# Build everything (development mode)
python build.py --dev

# Then start the app
cd app && pnpm run electron:dev
```

**Quick commands:**
```bash
python build.py --dev         # Development build
python build.py               # Production build
python build.py -e            # Engine only
python build.py -a            # App only
python build.py -t            # Build with tests
python build.py --help        # See all options
```

For detailed setup and troubleshooting, see the [Building Documentation](docs/building.md).

## Architecture

Vayu uses a sidecar pattern where the Electron UI (Manager) communicates with a separate C++ daemon (Engine) via HTTP:

```
┌────────────────────┐        ┌────────────────────┐
│   THE MANAGER      │  HTTP  │    THE ENGINE      │
│  (Electron/React)  │◄──────►│      (C++)         │
│                    │ :9876  │                    │
│  • Request Builder │        │  • EventLoop       │
│  • Collections     │        │  • QuickJS Runtime │
│  • Load Dashboard  │        │  • Multi-Worker    │
└────────────────────┘        └────────────────────┘
```

See [Architecture Documentation](docs/architecture.md) for detailed information.

## Tech Stack

- **Engine**: C++20 with lock-free data structures
- **Networking**: libcurl for HTTP client operations
- **Scripting**: QuickJS for test script execution
- **UI**: Electron + React + TypeScript
- **State Management**: Zustand (UI state) + TanStack Query (server state)
- **Build System**: CMake + vcpkg for C++, pnpm + Vite for Electron app

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System architecture and design decisions |
| [Engine API Reference](docs/engine/api-reference.md) | HTTP API for controlling the engine |
| [Building](docs/building.md) | Build instructions for all platforms |
| [Engine Building](docs/engine/building.md) | Building just the C++ engine |
| [Contributing](docs/contributing.md) | Guidelines for contributing |

## Contributing

Contributions are welcome! Please read the [Contributing Guide](docs/contributing.md) for details on:

- Development setup
- Code style guidelines
- Testing requirements
- Commit message conventions
- Pull request process

## Versioning & Releases

The canonical version for releases is stored in the top-level `VERSION` file. The CI workflow uses a pushed Git tag to publish artifacts.

**Key points:**

- The workflow triggers on tag pushes that follow the `v*` pattern (for example `v0.1.1`).
- Electron produces installer filenames that already contain the version (for example `Vayu Setup 0.1.1.exe` and `Vayu-0.1.1-x86_64.AppImage`), and the workflow uploads those files to the Release as-is.

**How to create a release (recommended):**

1. Bump the version using the build script:

```bash
python build.py --bump-version patch    # 0.1.1 -> 0.1.2
# or
python build.py --bump-version 0.1.2    # set specific version

# Preview changes first
python build.py --bump-version patch --dry-run
```

2. Commit the changes:

```bash
git add VERSION engine/include/vayu/version.hpp engine/CMakeLists.txt engine/vcpkg.json app/package.json
git commit -m "chore(release): 0.1.2"
```

3. Create and push a tag that matches the `VERSION` file, prefixed with `v`:

```bash
git tag v$(cat VERSION)
git push origin --tags
```

4. The workflow will run on the pushed tag, execute tests and builds, and upload installers to the Release associated with that tag.

**Notes:**

- The `VERSION` file is the single source of truth; maintain it before pushing tags.

## ⚖️ License

Vayu is a dual-licensed project:

* **Vayu Engine (`/engine`)**: Licensed under **GNU AGPL v3**.
* **Vayu UI (`/app`)**: Licensed under **Apache 2.0**.

**Usage Note:** You are free to use Vayu for any purpose. If you modify the **Engine** and provide it as a network service, you must open-source your changes. The **UI** is more permissive and allows for easier development.

---

**Built for developers who care about performance**

[Documentation](docs/) · [Report Bug](https://github.com/athrvk/vayu/issues) · [Request Feature](https://github.com/athrvk/vayu/issues)
