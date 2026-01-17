# Vayu

**High-Performance API Testing Platform**

[![License](https://img.shields.io/badge/license-Dual-blue.svg)](LICENSE)

Vayu combines the ease of use of API design tools like Postman with the raw performance of high-throughput load testing tools. Build and debug requests visually, then run the same tests at scale—all in one tool.

## Overview

Vayu uses a **sidecar architecture** that separates the user interface from the execution engine:

- **The Manager** (Electron + React): Provides a modern UI for building requests, managing collections, and viewing results
- **The Engine** (C++): A high-performance daemon capable of executing thousands of requests per second

The Manager communicates with the Engine via a local HTTP API on port 9876 (dynamically assigned, if not available), allowing each component to be optimized for its specific purpose.

## Features

- **High Performance** - Lock-free C++ engine optimized for maximum throughput
- **Request Management** - Organize requests into collections with folder hierarchy
- **Load Testing** - Run load tests with real-time metrics streaming
- **Environment Variables** - Manage variables across collections and environments
- **Test Scripting** - QuickJS-based scripting engine compatible with Postman's `pm.test()` syntax
- **Privacy First** - 100% local execution, no cloud sync required
- **Cross Platform** - macOS, Windows, and Linux support

## Quick Start

### Prerequisites

- **C++ Engine**: CMake 3.25+, C++20 compiler, vcpkg
- **Electron App**: Node.js ≥ 20 LTS, pnpm ≥ 8

### Building from Source

Clone the repository:

```bash
git clone https://github.com/athrvk/vayu.git
cd vayu
```

Build for your platform:

**macOS:**
```bash
./scripts/build/build-macos.sh dev
```

**Linux:**
```bash
./scripts/build/build-linux.sh dev
```

**Windows (PowerShell):**
```powershell
.\scripts\build\build-windows.ps1 dev
```

Then start the app:

```bash
cd app && pnpm run electron:dev
```

For production builds and detailed platform-specific instructions, see the [Building Documentation](docs/building-macos.md).

## Architecture

Vayu uses a sidecar pattern where the Electron UI (Manager) communicates with a separate C++ daemon (Engine) via HTTP:

```
┌────────────────────┐        ┌────────────────────┐
│   THE MANAGER      │  HTTP  │    THE ENGINE      │
│  (Electron/React)  │◄──────►│      (C++)         │
│                    │ :9876  │                    │
│  • Request Builder │        │  • Lock-free SPSC  │
│  • Collections     │        │  • QuickJS Runtime │
│  • Load Dashboard   │        │  • Multi-Worker    │
└────────────────────┘        └────────────────────┘
```

See [Architecture Documentation](docs/architecture.md) for detailed information.

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System architecture and design decisions |
| [Engine API Reference](docs/engine/api-reference.md) | HTTP API for controlling the engine |
| [Building (macOS)](docs/building-macos.md) | Build instructions for macOS |
| [Building (Linux)](docs/building-linux.md) | Build instructions for Linux |
| [Building (Windows)](docs/building-windows.md) | Build instructions for Windows |
| [Engine Building](docs/engine/building.md) | Building just the C++ engine |
| [Contributing](docs/contributing.md) | Guidelines for contributing |

## Tech Stack

- **Engine**: C++20 with lock-free data structures
- **Networking**: libcurl for HTTP client operations
- **Scripting**: QuickJS for test script execution
- **UI**: Electron + React + TypeScript
- **State Management**: Zustand (UI state) + TanStack Query (server state)
- **Build System**: CMake + vcpkg for C++, pnpm + Vite for Electron app

## Contributing

Contributions are welcome! Please read the [Contributing Guide](docs/contributing.md) for details on:

- Development setup
- Code style guidelines
- Testing requirements
- Commit message conventions
- Pull request process

## ⚖️ License

Vayu is a dual-licensed project:

* **Vayu Engine (`/engine`)**: Licensed under **GNU AGPL v3**.
* **Vayu UI (`/app`)**: Licensed under **Apache 2.0**.

**Usage Note:** You are free to use Vayu for any purpose. If you modify the **Engine** and provide it as a network service, you must open-source your changes. The **UI** is more permissive and allows for easier plugin development.

---

**Built for developers who care about performance**

[Documentation](docs/) · [Report Bug](https://github.com/athrvk/vayu/issues) · [Request Feature](https://github.com/athrvk/vayu/issues)
