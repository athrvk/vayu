# Vayu

**High-Performance API Testing & Load Platform**  
**Postman-compatible UI + C++ speed for thousands of requests/sec — all local, no cloud.**

Vayu gives you the familiar request builder and collections of Postman, but with a blazing-fast C++ engine that crushes load tests and high-throughput scenarios without slowing down your machine.  
Privacy-first, 100% offline execution. Built for developers who hate waiting.

[![Latest Release](https://img.shields.io/github/v/release/athrvk/vayu)](https://github.com/athrvk/vayu/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0%20%26%20Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/athrvk/vayu/releases)

[![GitHub stars](https://img.shields.io/github/stars/athrvk/vayu?style=social&label=Star)](https://github.com/athrvk/vayu)
[![GitHub forks](https://img.shields.io/github/forks/athrvk/vayu?style=social&label=Fork)](https://github.com/athrvk/vayu/fork)
[![GitHub issues](https://img.shields.io/github/issues/athrvk/vayu)](https://github.com/athrvk/vayu/issues)

![C++](https://img.shields.io/badge/C++-20-blue?logo=cplusplus)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![Electron](https://img.shields.io/badge/Electron-28-47848F?logo=electron)

## Why Vayu? (vs Postman & others)

# Vayu Performance & Capability Comparison

| Feature                   | Vayu                           | k6                             | Apache JMeter                  | Postman                        |
|---------------------------|--------------------------------|--------------------------------|--------------------------------|--------------------------------|
| **Execution Engine** | C++ (High Performance)         | Go (Efficient / Lightweight)   | Java (JVM-based)               | Node.js / Electron             |
| **Execution Speed** | Tens of Thousands RPS (Native)        | High (Go-routines)             | Moderate (Thread-heavy)        | Limited by JS runtime          |
| **Scripting Language** | QuickJS (pm syntax support)     | JavaScript (ES6)               | Groovy / BeanShell / GUI       | JavaScript                     |
| **Load Testing** | Built-in (Real-time metrics)   | Core focus                     | Core focus                     | Requires separate tool         |
| **UI / UX** | Native App (Sidecar Desktop)   | CLI-first (No native GUI)      | Java Swing GUI (Aged)          | Native App (Feature-rich)      |
| **UI Snappiness** | Responsive (Sidecar Architecture)| N/A (CLI only)                 | Laggy with large test plans    | Slows with large collections   |
| **Resource Usage** | Low (Direct memory access)     | Low to Moderate                | High (RAM intensive)           | High (Electron/Chrome)         |
| **Privacy** | 100% Local-first               | Local / Cloud hybrid           | 100% Local                     | Cloud-heavy (Optional local)   |
| **Postman Import** | Yes (Native compatibility, WIP)     | Limited (via converters)       | No (Manual migration)          | Native                         |
| **Protocols** | REST      | HTTP, gRPC, WebSockets         | HTTP, FTP, JDBC, LDAP, SOAP    | REST, GraphQL, gRPC            |
| **Open Source** | Yes (Dual-license)             | Yes (AGPLv3)                   | Yes (Apache 2.0)               | Partial                        |


## Features

- **High Performance** - C++ engine optimized for maximum throughput
- **Request Management** - Organize requests into collections with folder hierarchy
- **Load Testing** - Run load tests with real-time metrics streaming
- **Environment Variables** - Manage variables across collections and environments
- **Test Scripting** - QuickJS-based scripting engine compatible with Postman's `pm.test()` syntax
- **Privacy First** - 100% local execution, no cloud sync required
- **Cross Platform** - macOS, Windows, and Linux support

## 📦 Download

Download the latest version for your platform:

- **Windows**: [Vayu-x64.exe](https://github.com/athrvk/vayu/releases/latest/download/Vayu-x64.exe)
- **macOS**: [Vayu-universal.dmg](https://github.com/athrvk/vayu/releases/latest/download/Vayu-universal.dmg)
- **Linux**: [Vayu-x86_64.AppImage](https://github.com/athrvk/vayu/releases/latest/download/Vayu-x86_64.AppImage)

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