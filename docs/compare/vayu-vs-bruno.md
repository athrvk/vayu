---
title: "Bruno alternative: Vayu vs Bruno"
description: >-
  Vayu and Bruno are both local-first open source API clients. The split is
  Vayu's native C++ load engine, mock servers, SSE and agent-driven load runs.
---

# Vayu vs Bruno - two local-first API clients, one with a load engine

If you are comparing Vayu and Bruno, the usual dividing lines do not apply.
Both are open source, both run entirely on your machine, both refuse to make you
sign in, and both keep your work where you can see it. Choosing between them is
not a privacy question - it is a question of what you want the tool to do after
the request comes back green.

| | Vayu | Bruno |
|---|---|---|
| **Execution engine** | C++ (native) | Node.js / Electron |
| **API client + load test** | Both, one app | Client only |
| **Load test throughput** | Tens of thousands of req/s | Limited by the JS runtime |
| **Privacy / offline** | 100% local, no account | 100% local |
| **Storage** | Local SQLite database | Plain-text `.bru` files in your repo |
| **Scripting** | QuickJS (`pm.*` syntax) | JavaScript (ES6) |
| **MCP / agent control** | Built in, local, drives the load engine | Official server, wraps the CLI |
| **SSE streaming** | Live Events view, scriptable, load-tested | Connects, no event UI |
| **Mock servers** | Collection mock + OAuth issuer + webhook inbox | No |
| **Data-driven runs** | CSV / TSV / JSON / JSONL | CSV / JSON |
| **Proxy / custom CA / client certs** | In Settings - four proxy modes, additive CAs, per-host certs\* | In Preferences - proxy and CA file; certs per collection |
| **Postman collection import** | Yes (v2.0 + v2.1) | Yes (via converter) |
| **OpenAPI import** | Yes (3.1 / 3.0 / 2.0) | No |
| **Open source** | Yes (dual-license) | Yes (MIT) |

\* **Two asterisks that row has earned.** Client certificates are proven on a
wire on Linux and macOS; **on Windows an mTLS handshake does not complete
yet** - an upstream libcurl defect carried in curl's own `KNOWN_BUGS`, not a
setting you can fix, with the backend change that resolves it approved and
queued. And `system` proxy mode resolves a PAC script **once**, against a probe
URL, applying that one answer engine-wide rather than per URL; a headless
engine with nothing resolved falls back to environment-variable pickup rather
than to no proxy. Detail:
[proxy settings](../engine/api-reference.md#proxy-settings),
[TLS trust](../engine/api-reference.md#tls-trust-settings) and
[client certificates](../engine/api-reference.md#client-certificates).

## The native load engine is the difference

Bruno's collection runner executes your requests in sequence on a Node.js
runtime - correct for a functional suite, and not built to be a load generator.
Vayu's engine is a separate C++20 process driving a multi-worker libcurl event
loop, which is why a single laptop reaches **tens of thousands of req/s** and why
the interface stays smooth while it does: the renderer never shares a thread with
the request load. On a loopback target the engine measured **56,880 req/s**,
matching `wrk` (54,280 in the same session) and edging past `vegeta` - full
[methodology and reproduction here](../engine/benchmarks.md). You get that from
the request you already built, not from a rewritten script in a second tool.

## Server surfaces, not just a client

Vayu also stands things up rather than only calling them. Saved response
examples can be served as a **live mock** of a collection, a **mock OAuth
issuer** covers the auth flows you would otherwise stub by hand, and a **webhook
inbox** captures inbound calls so you can assert on what a third party actually
sent you. **SSE** is a first-class request type with a live Events view, a Stop
control, scripts that assert on the buffered events, and event lists restored
from history - and streams stay bounded under load rather than buffering without
limit.

## Both have MCP; they hand the agent different things

Bruno ships an official MCP server that wraps its `bru` CLI, so an agent can run
your collections. Vayu's MCP server runs inside the app on `127.0.0.1:9877` and
exposes **24 typed tools** covering inspection, execution, **load runs**, and
writes over collections, requests and environments. The distinction worth caring
about is the load engine: an agent can start a capped load run and read the
report back. It is gated accordingly - an allowlist that starts empty, caps on
RPS, concurrency and duration, and a write toggle that ships off. See the
[MCP reference](../engine/mcp.md).

## When to choose Bruno

Bruno is a good tool, and two of its design choices are genuinely better for
some teams:

- **You want your API collection in git, as text.** Bruno's `.bru` files are
  plain text in your repository, so requests diff and review like code. Vayu
  stores the workspace in a local SQLite database and moves it by export - if
  reviewable-in-a-PR collections are the point, Bruno is built for it and Vayu
  is not.
- **You only need a client, and want the smallest one.** If load testing, mocks
  and agent-driven runs are not on your list, Bruno does the client job well
  without the engine alongside it.
- **You are standardising on its CLI in CI.** `bru` is mature and widely
  scripted. Vayu's [command line](../engine/cli.md) drives the engine, and the
  headless CI gate is still an open issue rather than a shipped feature.
- **You prefer an ES6 scripting model** to a `pm.*`-compatible one, or you are
  not coming from Postman at all.

## Try it

Windows:

```powershell
winget install athrvk.Vayu
```

macOS and Linux:

```sh
bash -c "$(curl -fsSL https://athrvk.github.io/vayu/install.sh)"
```

[Full install detail](../index.md#install){ .md-button .md-button--primary }
[Compare with k6](vayu-vs-k6.md){ .md-button }
