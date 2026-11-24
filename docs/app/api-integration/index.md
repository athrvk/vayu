---
description: >-
  How the Vayu Electron app talks to the C++ engine over local HTTP - endpoints, request shapes, streaming, and error handling.
---

# API Integration

This document describes how the Vayu Manager communicates with the Vayu Engine (C++ daemon) via HTTP.

## Pages

Each page holds one part of the integration.

| Page | Covers |
|---|---|
| [HTTP client and API service](http-client-and-service.md) | `services/http-client.ts`, `services/api.ts`, data transformation |
| [API methods: configuration and local services](methods-local.md) | Health and configuration, cookie jar, allowed folders, webhook inbox, OAuth 2.0 mock issuer, collection mock server |
| [API methods: collections, requests and examples](methods-saved.md) | Request examples, create vs update, collections, requests, trash, reorder |
| [API methods: specs](methods-specs.md) | Specs |
| [API methods: environments, globals and import](methods-environments-import.md) | Environments, global variables, import |
| [API methods: execution and runs](methods-execution.md) | Execution, run management |
| [API methods: OAuth 2.0 and scripting](methods-oauth-scripting.md) | OAuth 2.0, scripting |
| [SSE Client (`services/sse-client.ts`)](sse-client.md) | `services/sse-client.ts` |
| [API Endpoints (`config/api-endpoints.ts`)](endpoints.md) | `config/api-endpoints.ts` |
| [Request Execution Flow](execution-flow.md) | Single request execution, load test execution |
| [Streaming Request Execution](streaming.md) | Streaming request execution |
| [Errors and connection management](errors-and-connection.md) | Error handling, health checking, engine startup |
| [Best practices, testing and troubleshooting](testing-and-troubleshooting.md) | Best practices, mocking, troubleshooting |

## Overview

The app communicates with the engine through:
- **HTTP REST API**: For CRUD operations and request execution
- **Server-Sent Events (SSE)**: For real-time load test metrics

All communication happens on `127.0.0.1:9876`, or on a fallback port (9880-9889) when another program holds 9876 (issue #2118).
The main process chooses the port before the window exists and the preload exposes it as `electronAPI.enginePort`; `config/network.ts` reads it once into `ENGINE_BASE_URL`, and everything the renderer sends goes through that.
With no preload (a browser tab, the test suite) it is 9876.

## API Client Architecture

```
┌─────────────────────────────────────────┐
│         React Components                │
│  (RequestBuilder, Dashboard, etc.)     │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  Hooks + singletons                     │
│  (useEngine, queries/, loadTestService) │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│         Services Layer                  │
│  - api.ts (HTTP client)                │
│  - sse-client.ts (SSE client)          │
│  - http-client.ts (fetch wrapper)       │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│         Vayu Engine                     │
│  (localhost:9876)                      │
└─────────────────────────────────────────┘
```
