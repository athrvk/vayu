<div align="center">

# ⚡ Vayu

**The High-Performance, Open-Source API Development Platform**

*Write once. Debug visually. Scale instantly.*

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-Universal-000000?logo=apple)](https://github.com/vayu/vayu/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/vayu/vayu/ci.yml?branch=main)](https://github.com/vayu/vayu/actions)

</div>

---

## The Problem

In the current API development landscape, engineers maintain **two separate workflows**:

| Tool Type | Examples | Strengths | Weaknesses |
|-----------|----------|-----------|------------|
| **Design & Debug** | Postman, Insomnia, Bruno | Great UI, easy scripting | Single-threaded, ~100 RPS max |
| **Load & Stress Test** | k6, JMeter, Gatling | 50k+ RPS | Requires rewriting tests, poor UX |

**The pain:** Build tests in Postman to verify logic. Rewrite those same tests in k6 to verify scale.

---

## The Solution

**Vayu** is a hybrid API tool that combines:
- 🎨 **Design Mode:** Postman-like UI for building and debugging requests
- ⚡ **Vayu Mode:** C++ engine capable of 50,000+ requests per second

**One tool. One test suite. Debug at 1 RPS. Load test at 50,000 RPS.**

---

## Features

- 🚀 **High Performance** - C++ engine with non-blocking I/O (libcurl + curl_multi)
- 📝 **Postman Compatible** - Import collections, use familiar `pm.test()` syntax
- 🔒 **Privacy First** - 100% local, no cloud sync, your data stays yours
- 🆓 **Open Source** - MIT licensed, free forever
- 💻 **Cross Platform** - macOS today, Windows & Linux coming soon

---

## Quick Start

### Download

**macOS (Universal)**
```bash
# Homebrew (coming soon)
brew install --cask vayu

# Or download from releases
open https://github.com/vayu/vayu/releases
```

### Your First Request

1. Launch Vayu
2. Enter `https://httpbin.org/get`
3. Click **Send**

### Your First Load Test

1. Configure your request
2. Click the **⚡ Vayu** button
3. Set: `100 connections`, `60 seconds`
4. Click **Start Test**
5. Watch real-time stats: RPS, latency percentiles, error rates

---

## Architecture

```
┌────────────────────┐        ┌────────────────────┐
│   THE MANAGER      │  HTTP  │    THE ENGINE      │
│  (Electron/React)  │◄──────►│      (C++)         │
│                    │        │                    │
│  • Request Builder │        │  • libcurl         │
│  • Response Viewer │        │  • QuickJS         │
│  • Dashboard       │        │  • Thread Pool     │
│  • Collections     │        │  • 50k+ RPS        │
└────────────────────┘        └────────────────────┘
```

See [Architecture Documentation](docs/architecture.md) for details.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/getting-started.md) | Installation and basics |
| [Architecture](docs/architecture.md) | How Vayu works |
| [API Reference](docs/api-reference.md) | Engine Control API |
| [Postman Migration](docs/postman-migration.md) | Import from Postman |
| [Building](docs/building.md) | Build from source |
| [Contributing](docs/contributing.md) | How to contribute |

---

## Roadmap

- [x] Project design & planning
- [ ] **Phase 1:** Engine prototype (CLI with libcurl + QuickJS)
- [ ] **Phase 2:** Core engine (50k RPS, Control API, SSE)
- [ ] **Phase 3:** Electron app (UI integration)
- [ ] **Phase 4:** Polish (Postman import, packaging, releases)

See [PLAN.md](PLAN.md) for detailed roadmap.

---

## Contributing

We welcome contributions! See [Contributing Guide](docs/contributing.md).

```bash
# Clone
git clone https://github.com/vayu/vayu.git

# Build engine
cd engine && cmake -B build && cmake --build build

# Build app
cd ../app && pnpm install && pnpm dev
```

---

## Tech Stack

| Component | Technology | Why |
|-----------|------------|-----|
| Engine | C++20 | Maximum performance, manual memory control |
| Networking | libcurl | Battle-tested, HTTP/1.1, H/2, H/3 support |
| Scripting | QuickJS | 500KB, microsecond startup, Postman-compatible |
| UI | Electron + React | Fast development, familiar ecosystem |
| Build | CMake + vcpkg | Industry standard C++ tooling |

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">

**Built with ❤️ for developers who care about performance**

[Documentation](docs/) · [Report Bug](https://github.com/vayu/vayu/issues) · [Request Feature](https://github.com/vayu/vayu/issues)

</div>
