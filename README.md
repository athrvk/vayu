# Vayu — Open Source API Testing & Load Testing Desktop App

**Local-first Postman alternative with a C++ engine built for load testing — no cloud, no subscription, no limits.**

Vayu is a free, open source desktop app for REST API testing and load testing on Windows, macOS, and Linux. It combines the familiar request-builder and collections UI of Postman with a native C++ execution engine that sustains tens of thousands of requests per second — all running locally on your machine, with zero data leaving your network.

[![Latest Release](https://img.shields.io/github/v/release/athrvk/vayu)](https://github.com/athrvk/vayu/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0%20%26%20Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/athrvk/vayu/releases)
[![GitHub stars](https://img.shields.io/github/stars/athrvk/vayu?style=social&label=Star)](https://github.com/athrvk/vayu)
[![GitHub issues](https://img.shields.io/github/issues/athrvk/vayu?style=social&label=Issues)](https://github.com/athrvk/vayu/issues)

![C++](https://img.shields.io/badge/C++-20-blue?logo=cplusplus)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![Electron](https://img.shields.io/badge/Electron-28-47848F?logo=electron)

---

## What is Vayu?

Vayu is a desktop API client and load testing tool that runs entirely on your local machine. Unlike Postman or Insomnia, there is no account required, no cloud sync, and no usage limits. You organize HTTP requests into collections, run them against any API, and launch high-throughput load tests — all from the same UI.

The key difference from other API clients is the execution engine: Vayu's HTTP engine is written in C++20 and uses a multi-worker event loop backed by libcurl. This lets it sustain load test throughput that Node.js-based tools (Postman, Bruno, Insomnia) cannot match, while keeping the Electron UI fully responsive during a test run.

Vayu supports importing collections from **Postman** (v2.0, v2.1), **Insomnia** (v4), and **OpenAPI / Swagger** (2.0, 3.0) specs, so migrating an existing workspace takes seconds.

---

## Why Vayu? (vs Postman, Bruno, k6, JMeter)

| Feature | Vayu | Bruno | k6 | Apache JMeter | Postman |
|---|---|---|---|---|---|
| **Execution Engine** | C++ (Native) | Node.js / Electron | Go | Java (JVM) | Node.js / Electron |
| **Load Test Throughput** | Tens of thousands RPS | Limited by JS runtime | High (Go routines) | Moderate (thread-heavy) | Requires separate tool |
| **Scripting** | QuickJS (`pm.*` syntax) | JavaScript (ES6) | JavaScript (ES6) | Groovy / BeanShell | JavaScript |
| **Built-in Load Testing** | Yes — real-time metrics | No | Core focus | Core focus | No |
| **UI** | Native desktop app | Native desktop app | CLI only | Java Swing (dated) | Native desktop app |
| **UI Responsiveness** | High (sidecar arch) | Good | N/A | Laggy under load | Slows with large collections |
| **Memory Usage** | Low (direct memory) | Low–Moderate | Low–Moderate | High (RAM-intensive) | High (Electron + Chrome) |
| **Privacy / Offline** | 100% local, no account | 100% local | Local / cloud hybrid | 100% local | Cloud-heavy (optional local) |
| **Postman Collection Import** | Yes (v2.0 + v2.1) | Yes (via converter) | Limited | No | Native |
| **OpenAPI Import** | Yes (2.0 + 3.0) | No | No | No | Yes |
| **Open Source** | Yes (dual-license) | Yes (MIT) | Yes (AGPL v3) | Yes (Apache 2.0) | Partial |

---

## Features

- **High-throughput load testing** — C++ event loop sustains tens of thousands of requests/sec with real-time metrics streaming; no separate tool (k6, JMeter) needed
- **REST API request builder** — send GET, POST, PUT, PATCH, DELETE and more; supports JSON, form-data, URL-encoded, raw text, and GraphQL bodies
- **Collections & folder hierarchy** — organise requests into nested collections with per-collection variables, auth, and pre/post scripts
- **Collection import** — import from Postman v2.0/v2.1, Insomnia v4, OpenAPI 3.0, and Swagger 2.0 in one file drop
- **Environment & variable management** — layered variable resolution: globals → collection chain → active environment
- **Auth support** — Bearer token, Basic auth, API key (header or query); auth inherits down the collection tree
- **Test scripting** — QuickJS engine with `pm.test()`, `pm.expect()`, `pm.environment.set()` — compatible with Postman test scripts
- **Script composition** — pre-request and post-request scripts compose across the collection hierarchy (root → folder → request)
- **Privacy-first** — 100% offline execution; no telemetry, no account, no cloud sync
- **Cross-platform** — native installers for Windows (x64), macOS (universal), and Linux (AppImage)

---

## Download

| Platform | Installer |
|---|---|
| **Windows** | [Vayu-x64.exe](https://github.com/athrvk/vayu/releases/latest/download/Vayu-x64.exe) |
| **macOS** | One-command install (see below) |
| **Linux** | [Vayu-x86_64.AppImage](https://github.com/athrvk/vayu/releases/latest/download/Vayu-x86_64.AppImage) |

[View all releases →](https://github.com/athrvk/vayu/releases)

No installation wizard needed on Linux — mark the AppImage executable and run it.

### macOS (one-command install)

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/athrvk/vayu/master/install.sh)"
```

Installs the latest release to `/Applications` (you'll be prompted for your password). To pin a version:

```sh
VAYU_VERSION=0.1.3 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/athrvk/vayu/master/install.sh)"
```

Vayu is distributed unsigned (no Apple Developer certificate); the installer ad-hoc signs it and clears the download quarantine so it launches without the "damaged" warning. You can read the script before running it at the URL above.

**Uninstall** (keep your data):

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/athrvk/vayu/master/install.sh)" -- --uninstall
```

Add `--purge` to also delete settings and data. Alternatively, drag `Vayu.app` from `/Applications` to the Trash.

---

## Quick Start

### Prerequisites

- **C++ Engine**: CMake 3.25+, C++20 compiler (g++ or clang++), vcpkg
- **Electron App**: Node.js ≥ 20 LTS, pnpm ≥ 10

### Building from Source

```bash
git clone https://github.com/athrvk/vayu.git
cd vayu

# Development build (engine + app)
python build.py --dev

# Start the app
cd app && pnpm run electron:dev
```

**All build commands:**
```bash
python build.py --dev    # Development build
python build.py          # Production build
python build.py -e       # Engine only
python build.py -a       # App only
python build.py -t       # Build with tests
python build.py --help   # All options
```

For platform-specific setup and troubleshooting, see [Building Documentation](docs/building.md).

---

## Architecture

Vayu uses a **sidecar architecture**: the Electron UI (Manager) and the C++ daemon (Engine) are separate processes that communicate over HTTP on `localhost:9876`. This keeps the UI fully responsive even when the engine is saturating the network under a load test.

```
┌────────────────────┐        ┌────────────────────┐
│   THE MANAGER      │  HTTP  │    THE ENGINE      │
│  (Electron/React)  │◄──────►│      (C++)         │
│                    │ :9876  │                    │
│  • Request Builder │        │  • Event Loop      │
│  • Collections     │        │  • QuickJS Runtime │
│  • Load Dashboard  │        │  • Multi-Worker    │
└────────────────────┘        └────────────────────┘
```

See [Architecture Documentation](docs/architecture.md) for more detail.

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | Electron + React 19 + TypeScript 5 |
| UI state | Zustand |
| Server state | TanStack Query |
| Styling | Tailwind CSS v4 |
| HTTP engine | C++20 + libcurl |
| Scripting | QuickJS (embedded JS engine) |
| Database | SQLite via sqlite_orm |
| Build | CMake + vcpkg (C++), pnpm + Vite (app) |

---

## Documentation

| Document | Description |
|---|---|
| [Architecture](docs/architecture.md) | Sidecar pattern, process model, IPC |
| [Engine API Reference](docs/engine/api-reference.md) | Full HTTP API for the C++ engine |
| [DB Schema](docs/engine/db-schema.md) | SQLite table definitions and JSON shapes |
| [Variable Resolution](docs/app/variable-resolution.md) | How `{{variables}}` are resolved at runtime |
| [Building](docs/building.md) | Build instructions for all platforms |
| [Contributing](CONTRIBUTING.md) | Dev setup, code style, PR process |

---

## Contributing

Contributions are welcome. Read the [Contributing Guide](CONTRIBUTING.md) for dev setup, code style, testing requirements, and the PR process.

---

## Versioning & Releases

The canonical version is stored in the top-level `VERSION` file. CI builds and uploads installers when a matching `v*` tag is pushed.

```bash
# 1. Bump version
python build.py --bump-version patch   # 0.1.1 → 0.1.2

# 2. Commit
git add VERSION engine/CMakeLists.txt engine/vcpkg.json app/package.json
git commit -m "chore(release): 0.1.2"

# 3. Tag and push — CI takes it from here
git tag v$(cat VERSION)
git push origin --tags
```

---

## FAQ

**Is Vayu free?**
Yes. Vayu is fully free and open source. The engine is licensed AGPL-3.0; the UI is Apache-2.0. There is no paid tier, no subscription, and no feature gating.

**Does Vayu work offline?**
Yes. All execution happens locally. Vayu never contacts external servers during normal use — no telemetry, no license checks, no cloud sync.

**Does Vayu require an account?**
No. Download, install, and use it immediately with no sign-up.

**Can I import my Postman collections into Vayu?**
Yes. Vayu imports Postman Collection v2.0 and v2.1 JSON exports directly, including folders, environments, variables, auth settings, and pre/post-request scripts.

**Can I import OpenAPI / Swagger specs?**
Yes. Drop in an OpenAPI 3.0 or Swagger 2.0 file (JSON or YAML) and Vayu generates a ready-to-use request collection from the spec.

**How fast is the load testing?**
The C++ engine sustains tens of thousands of requests per second on modern hardware. Exact numbers depend on your machine, the target server, and network conditions.

**What scripting syntax does Vayu support?**
Vayu uses QuickJS and implements the `pm.*` API (`pm.test()`, `pm.expect()`, `pm.environment.get/set()`, `pm.response.*`) so most Postman test scripts run without modification.

**Which platforms does Vayu support?**
Windows (x64), macOS (Apple Silicon + Intel universal), and Linux (x86_64 AppImage).

---

## License

Vayu is dual-licensed:

- **Engine (`/engine`)** — [GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0.html): if you modify the engine and offer it as a network service, you must publish your changes.
- **UI (`/app`)** — [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0): permissive; use freely in any project.

You are free to use Vayu for any purpose, commercial or personal, at no cost.
