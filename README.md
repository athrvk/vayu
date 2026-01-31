# Vayu

**High-Performance API Testing & Load Platform**  
**Postman-compatible UI + C++ speed for thousands of requests/sec — all local, no cloud.**

Vayu gives you the familiar request builder and collections of Postman, but with a blazing-fast C++ engine that crushes load tests and high-throughput scenarios without slowing down your machine.  
Privacy-first, 100% offline execution. Built for developers who hate waiting.

[![Latest Release](https://img.shields.io/badge/release-v0.1.1-green.svg)](https://github.com/athrvk/vayu/releases/latest)
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

---

### Key Takeaways

* **Vayu** bridges the gap between the user-friendly interface of **Postman** and the high-performance load generation of **k6/JMeter**. Its C++ sidecar architecture ensures that even during a heavy load test, the UI remains fluid and responsive.
* **k6** is the industry standard for "Testing as Code," making it ideal for CI/CD pipelines, though it lacks a built-in GUI for exploratory debugging.
* **Apache JMeter** remains the king of protocol diversity (supporting legacy systems like SOAP and LDAP), but suffers from high resource overhead and a steeper learning curve.
* **Postman** excels at API documentation and collaboration but is often criticized for its shift toward cloud-only features and slower performance at scale.

Vayu uses a **sidecar architecture**: React/Electron UI talks to a separate C++ daemon via local HTTP → no freezing during massive runs.

## ✨ Features

- **Visual Request Builder** — Folders, collections, environments, variables - Similar experience to Postman
- **High-Throughput Load Testing** — Ramp up to thousands of concurrent requests with live graphs
- **Postman-Compatible Scripting** — Use `pm.test()`, `pm.expect()`, etc. as you would in Postman
- **Real-Time Metrics** — Latency histograms, RPS, errors streamed live
- **Fully Local & Private** — Nothing leaves your machine
- **Cross-Platform** — Windows, macOS, Linux installers/AppImage

## 📸 See It in Action

<!-- Replace these with actual uploaded GIFs/screenshots -->

![Request Builder Demo](shared/request-builder.gif)  
*Building & sending requests with variables and tests*

![Load Test Dashboard](shared/load-test-dashboard.gif)  
*Running 5,000 RPS load test – UI stays smooth*

![Script Editor](shared/script-editor.png)  
*Writing Postman-style tests that run at native speed*

## 📦 Download & Install (v0.1.1)

Grab the latest release:

- **Windows**: [Vayu-0.1.1-x64.exe](https://github.com/athrvk/vayu/releases/download/v0.1.1/Vayu-0.1.1-x64.exe)
- **macOS**: [Vayu-0.1.1-universal.dmg](https://github.com/athrvk/vayu/releases/download/v0.1.1/Vayu-0.1.1-universal.dmg)
- **Linux**: [Vayu-0.1.1-x86_64.AppImage](https://github.com/athrvk/vayu/releases/download/v0.1.1/Vayu-0.1.1-x86_64.AppImage)

[All Releases →](https://github.com/athrvk/vayu/releases)

## 🚀 Quick Start

1. Download and install from above.
2. Launch Vayu → it auto-starts the C++ engine in the background.
3. Import your Postman collections (File → Import).
4. Build requests, add tests, or create a load test collection.
5. Run → watch thousands of requests fly.

Want to build from source? See [Building Guide](docs/building.md).

## 🛠 Architecture at a Glance

```
┌────────────────────┐        ┌────────────────────┐
│   MANAGER (UI)     │  HTTP  │     ENGINE         │
│ Electron + React   │◄──────►│     (C++ daemon)   │
│ • Collections      │ :9876  │ • High-perf runner │
│ • Request Builder  │        │ • QuickJS scripts  │
│ • Results Dashboard│        │ • Multi-threaded   │
└────────────────────┘        └────────────────────┘
```

Full details in [Architecture](docs/architecture.md).

## Tech Stack

- **Engine**: C++20, libcurl, QuickJS, lock-free structures
- **UI**: Electron, React 19, TypeScript, Zustand + TanStack Query
- **Build**: CMake/vcpkg (engine), pnpm/Vite (app)

## 📖 Documentation

- [Architecture & Design](docs/architecture.md)
- [Engine API Reference](docs/engine/api-reference.md)
- [Building from Source](docs/building.md)
- [Contributing Guidelines](docs/contributing.md)

## Contributing

Love performance and clean code? PRs welcome!  
Read [Contributing Guide](docs/contributing.md) first.

Star ⭐ if you're excited — helps spread the word!

**Built for devs who demand speed without sacrificing usability.**

[Report Bug](https://github.com/athrvk/vayu/issues/new?labels=bug&template=bug_report.md) · [Request Feature](https://github.com/athrvk/vayu/issues/new?labels=enhancement&template=feature_request.md) · [Discussions](https://github.com/athrvk/vayu/discussions)