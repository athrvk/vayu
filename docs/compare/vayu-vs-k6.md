---
title: "k6 alternative: Vayu vs k6"
description: >-
  k6 is a load tester you script. Vayu is the API client you already built the
  request in, with a native C++ engine at the same throughput class as wrk.
---

# Vayu vs k6 - k6-class throughput from the client you already built the request in

k6 is a load tester you script. Vayu is an **API client with a load tester
inside it**. That is the whole comparison in one line, and it decides which one
you want: if the request already exists in your client, Vayu points the engine at
it and skips the translation step. If load testing is a discipline of its own in
your team - written as code, reviewed, run in CI, executed from several regions -
k6 was built for exactly that and Vayu is not trying to be it.

| | Vayu | k6 |
|---|---|---|
| **Execution engine** | C++ (native) | Go |
| **API client + load test** | Both, one app | Load test only |
| **How a test is defined** | The request you built, in the UI | A JavaScript test script |
| **UI** | Native desktop app | CLI only |
| **Live metrics** | Streamed over SSE into a live dashboard | Terminal output, or an external dashboard |
| **Scripting** | QuickJS (`pm.*` syntax) | JavaScript (ES6) |
| **Distributed / cloud execution** | No - single machine | Yes |
| **MCP / agent control** | Built in, local, drives the load engine | Official server (experimental) |
| **Data-driven runs** | CSV / TSV / JSON / JSONL | Yes (in script) |
| **Proxy / custom CA / client certs** | In Settings - four proxy modes, additive CAs, per-host certs\* | Environment variables and script options (`tlsAuth`) |
| **Postman collection import** | Yes (v2.0 + v2.1) | Limited |
| **OpenAPI import** | Yes (3.1 / 3.0 / 2.0) | No |
| **Open source** | Yes (dual-license) | Yes (AGPL v3) |

\* **One asterisk that row has earned.** `system` proxy mode resolves a PAC
script **once**, against a probe URL, applying that one answer engine-wide
rather than per URL; a headless engine with nothing resolved falls back to
environment-variable pickup rather than to no proxy. Client certificates carry
no qualification any more - they are proven on a wire on all three platforms,
in both PEM-pair and PKCS#12 form. Detail:
[proxy settings](../engine/api-reference.md#proxy-settings),
[TLS trust](../engine/api-reference.md#tls-trust-settings) and
[client certificates](../engine/api-reference.md#client-certificates).

## The throughput is in the same class

The reason this is a real comparison and not a toy one is that Vayu's engine is
native. Measured against the same mock server, on the same machine, in the same
session, at matched concurrency 64:

| Client | req/s | vs wrk |
|---|---:|:---:|
| **Vayu** | **56,880** | **105%** |
| wrk | 54,280 | 100% |
| vegeta | 51,847 | 96% |

All three converge on the same **~57k system ceiling** - and at that ceiling the
machine is still 79% idle, so it is the target saturating, not the client.
Driven from the app's own UI rather than a standalone daemon, a 60-second run
sustained **51,922 req/s across 3,115,391 requests with zero errors**, p50
1.20 ms / p99 1.52 ms, with the charts streaming throughout. A head-to-head
against k6 itself is not published here, because it has not been run on this
hardware - the [benchmarks page](../engine/benchmarks.md) carries the full
methodology and a one-command reproduction so you can measure your own.

One caveat, carried over from the benchmarks page: an earlier
2026-07 CLI session measured the opposite curve shape - Vayu at **66%** of
`wrk` at this same concurrency 64 - and the two measurements have not been
reconciled. The 105% above is the newer of the two, not a settled result; the
gap is too large to be run-to-run noise, so one of them is not measuring what
it claims. Read both before quoting either:
[prior results (2026-07, CLI, unreconciled)](../engine/benchmarks.md#prior-results-2026-07-cli-unreconciled).

## No translation step, and a dashboard while it runs

With k6 the request you debugged in a client becomes a `http.post(...)` call you
write again in a test script, and its correctness is now a second thing to keep
in sync. In Vayu the load run **is** the saved request, with its collection
variables, its auth resolved engine-side, and its scripts. A collection can be
run as an ordered scenario, in design mode or under load, with per-step results
and threshold verdicts. While it runs you watch throughput, latency percentiles
and error counters stream live over SSE rather than reading a summary after the
fact, and every run stays in the history sidebar to be
[compared against another](../engine/mcp.md).

## When to choose k6

For pure load-testing work, several things point the other way, and most of them
are not close:

- **You need distributed or cloud execution.** k6 runs from multiple machines and
  regions. Vayu drives load from the one machine it is installed on.
- **Load tests belong in CI.** k6 is CLI-first and designed to gate a pipeline.
  Vayu's engine has a [command line](../engine/cli.md), but it starts a run
  rather than gating one: there is no wait-and-exit-code gate, and that is a
  parked decision rather than a pending one -
  [#473](https://github.com/athrvk/vayu/issues/473) was closed unimplemented.
- **You want tests as reviewable code.** A k6 script is a file in your repo with
  a rich ecosystem around it - executors, scenarios, custom metrics, extensions,
  and output integrations to Prometheus, Grafana and others.
- **You are load testing beyond HTTP** - gRPC, WebSockets, or a real browser.
  Vayu's engine is an HTTP engine.
- **You need sophisticated arrival-rate modelling** (ramping executors, staged
  profiles). Vayu runs closed-loop constant concurrency, which is the right model
  for "does this endpoint hold" and not for reproducing a traffic shape.

The honest summary: k6 is the better load tester, Vayu is the better place to
build the request, and Vayu closes enough of the gap that most teams stop needing
both.

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
[Compare with JMeter](vayu-vs-jmeter.md){ .md-button }
