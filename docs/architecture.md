# Vayu System Architecture

**Document Version:** 1.0  
**Last Updated:** January 2, 2026

---

## Overview

Vayu uses a **Sidecar Architecture** that decouples the user interface from the execution engine. This separation allows each component to be optimized for its specific purpose:

- **The Manager** (Electron/React): Optimized for user experience
- **The Engine** (C++): Optimized for raw performance

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Vayu Application                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────┐      ┌─────────────────────────────┐  │
│  │     THE MANAGER         │      │        THE ENGINE           │  │
│  │   (Electron + React)    │      │          (C++)              │  │
│  │                         │      │                             │  │
│  │  ┌───────────────────┐  │      │  ┌───────────────────────┐  │  │
│  │  │   Request Builder │  │      │  │    Control Server     │  │  │
│  │  │   Response Viewer │  │ HTTP │  │    (cpp-httplib)      │  │  │
│  │  │   Dashboard       │◄─┼──────┼─►│    Port: 9876         │  │  │
│  │  │   Collections     │  │      │  └───────────────────────┘  │  │
│  │  └───────────────────┘  │      │             │               │  │
│  │           │             │      │             ▼               │  │
│  │           │             │      │  ┌───────────────────────┐  │  │
│  │           ▼             │      │  │    Thread Pool        │  │  │
│  │  ┌───────────────────┐  │      │  │  ┌─────┐ ┌─────┐     │  │  │
│  │  │   Sidecar Manager │  │      │  │  │ W1  │ │ W2  │ ... │  │  │
│  │  │   (spawn/kill)    │  │      │  │  └──┬──┘ └──┬──┘     │  │  │
│  │  └───────────────────┘  │      │  └─────┼──────┼─────────┘  │  │
│  │                         │      │        │      │            │  │
│  └─────────────────────────┘      │        ▼      ▼            │  │
│                                   │  ┌───────────────────────┐  │  │
│                                   │  │  curl_multi Handles   │  │  │
│                                   │  │  (Event Loops)        │  │  │
│                                   │  └───────────────────────┘  │  │
│                                   │             │               │  │
│                                   │             ▼               │  │
│                                   │  ┌───────────────────────┐  │  │
│                                   │  │  QuickJS Context Pool │  │  │
│                                   │  │  (Script Execution)   │  │  │
│                                   │  └───────────────────────┘  │  │
│                                   │                             │  │
│                                   └─────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The Manager (Electron + React)

The Manager is the "face" of Vayu—a standard Electron application that provides the graphical interface.

See [App Architecture](app/architecture.md) for details.

---

## The Engine (C++)

The Engine is the "muscle"—a headless daemon optimized for maximum I/O throughput.

See [Engine Architecture](engine/architecture.md) for internals.

---

## Communication Protocol

The Manager communicates with the Engine via a localhost HTTP API on port 9876.

### Request/Response Flow

```
Manager                              Engine
   │                                    │
   │  POST /run                         │
   │  {request, config}                 │
   ├───────────────────────────────────►│
   │                                    │
   │  200 OK {runId}                    │
   │◄───────────────────────────────────┤
   │                                    │
   │  GET /stats/{runId} (SSE)          │
   ├───────────────────────────────────►│
   │                                    │
   │  event: stats                      │
   │  data: {rps, latency, ...}         │
   │◄───────────────────────────────────┤
   │                          (repeated) │
   │  event: complete                   │
   │  data: {summary}                   │
   │◄───────────────────────────────────┤
```

See [Engine API Reference](engine/api-reference.md) for complete endpoint documentation.

---

## Security

- **Script Sandboxing:** QuickJS contexts are isolated with no filesystem or network access
- **Local-Only Communication:** Control API only binds to `127.0.0.1`
- **Secret Management:** Sensitive values encrypted at rest, never logged in plaintext

---

*See: [Engine Architecture](engine/architecture.md) | [App Architecture](app/architecture.md) →*
