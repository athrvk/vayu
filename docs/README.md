# Vayu Documentation

## Documents

| Document | Description |
|----------|-------------|
| [Getting Started](getting-started.md) | Installation and first steps |
| [Architecture](architecture.md) | System design overview |
| [Contributing](contributing.md) | How to contribute |

### Engine (C++)

| Document | Description |
|----------|-------------|
| [Building](engine/building.md) | Compile from source |
| [API Reference](engine/api-reference.md) | HTTP API endpoints |
| [Architecture](engine/architecture.md) | Engine internals |
| [CLI Reference](engine/cli.md) | Command-line tool |
| [Scripting](engine/scripting.md) | QuickJS scripting API |

### App (Electron/React)

| Document | Description |
|----------|-------------|
| [README](../app/README.md) | App overview |
| [Components](../app/docs/COMPONENTS.md) | Component hierarchy |
| [Data Models](../app/docs/DATA-MODELS.md) | TypeScript types |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         Vayu                                │
├──────────────────────────┬──────────────────────────────────┤
│    Manager (Electron)    │         Engine (C++)             │
│    React + TypeScript    │         Port 9876                │
│                          │                                  │
│  ┌────────────────────┐  │  ┌────────────────────────────┐  │
│  │ Request Builder    │  │  │ HTTP Control Server        │  │
│  │ Load Test Dashboard│◄─┼──┼─► (cpp-httplib)            │  │
│  │ Collections        │  │  │                            │  │
│  │ Variables          │  │  │ Thread Pool (N workers)    │  │
│  └────────────────────┘  │  │   └─► curl_multi handles   │  │
│                          │  │                            │  │
│                          │  │ QuickJS (scripting)        │  │
│                          │  │ SQLite (storage)           │  │
│                          │  └────────────────────────────┘  │
└──────────────────────────┴──────────────────────────────────┘
```

## Quick Start

```bash
# Build engine
cd engine
../scripts/build-and-test.sh -s

# Start engine
./build/vayu-engine --verbose 2

# Build and run app (new terminal)
cd app
pnpm install
pnpm electron:dev
```
