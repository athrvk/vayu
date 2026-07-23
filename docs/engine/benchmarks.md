# Engine Benchmarks - Vayu vs wrk vs vegeta

How fast is Vayu's load-test engine relative to the established native load
testers? This page documents a head-to-head against
[`wrk`](https://github.com/wg/wrk) and [`vegeta`](https://github.com/tsenart/vegeta),
the methodology, and how to reproduce it.

**TL;DR - Vayu is in the same performance class as wrk and vegeta.** At
saturation concurrency it matches/slightly exceeds vegeta and reaches **~93% of
wrk at c=128 and ~96% at c=256**, with all three converging on the same system
throughput ceiling. wrk remains the efficiency leader at low connection counts.

## Methodology

- **All three clients hit the same mock server** (`scripts/test/mock-server.go`,
  `:8080`, `/fast` endpoint - an 11-byte response with ~1 µs handler latency),
  so the comparison is apples-to-apples.
- **CLI only - no UI.** Measurements drive `vayu-cli → daemon` directly. The
  Electron UI is *not* used for performance numbers: its renderer (Chromium
  compositor + React re-drawing the live SVG charts every metrics tick) contends
  for the same CPU cores as the engine and depresses throughput by ~30–40%. The
  UI is for *driving and visualising* tests, not for measuring peak engine RPS.
- **Matched concurrency.** wrk holds `-c` connections, vegeta runs
  `-rate=0 -max-workers=N` (open-loop, capped workers), Vayu runs closed-loop
  constant-concurrency (`concurrency=N`, no target rate). 10–12 s per run, with
  cooldowns between runs.
- All runs are **error-free** (0 non-2xx, 0 failures).

### Hardware

MacBook Pro **M3 Pro, 18 GB**, macOS. 12 cores = **6 performance + 6 efficiency**
(no SMT). This asymmetry matters: macOS assigns threads to P- vs E-cores by QoS
class, and on a single machine the load-test *client and the mock server share
the same 12 cores* - so the measured ceiling (~57k RPS for a trivial request) is
a **shared system limit**, not any one client's ceiling.

## Results

### Throughput vs concurrency (single run each, `/fast`, workers=8)

| concurrency | wrk (req/s) | vegeta (req/s) | vayu (req/s) | vayu / wrk |
|------------:|------------:|---------------:|-------------:|:----------:|
| 64          | 56,649      | 44,065         | 37,148       | 66%        |
| 128         | 57,765      | 55,783         | 51,385       | 89%        |
| 256         | 56,124      | 52,837         | **53,967**   | **96%**    |

### Clean repeated runs @ c=128 (cooled, 12 s each)

| rep | wrk (req/s) | vegeta (req/s) | vayu (req/s) |
|----:|------------:|---------------:|-------------:|
| 1   | 56,884      | 49,258         | 50,772       |
| 2   | 56,978      | 55,960         | 53,868       |
| 3   | 56,543      | 56,215         | 53,835       |
| **avg** | **56,802** | **53,811**  | **52,825**   |

At c=128 Vayu averages **93% of wrk** and **98% of vegeta**.

## Reading the results

- **Convergence at the ceiling.** Pushing past the optimum (c=256) makes *every*
  client slower (wrk 57,765 → 56,124; vayu peaks then dips) - the classic sign
  that the bottleneck is the shared server/CPU, not the client. Vayu reaches that
  ceiling as effectively as the best tools.
- **wrk leads at low concurrency.** With only 64 connections wrk already
  saturates the server (56.6k) while vayu and vegeta need more connections to get
  there. wrk's bespoke kqueue event loop has the lowest per-connection overhead;
  Vayu uses libcurl-multi, which carries more per-request machinery, so it scales
  *up* to the ceiling rather than hitting it immediately.
- **Vayu ≈ vegeta, ~5–10% behind wrk.** A fair, defensible claim:
  *Vayu is on par with vegeta and competitive with wrk* - not faster than wrk.

## Engine tuning notes

Knobs that move RPS (set via `POST /config`; read **per run** by the engine - no
restart needed despite the "Requires Restart" label on some):

- **`workers`** - libcurl-multi event-loop threads. Inverted-U with a peak around
  **7–9** on this 6P+6E machine; 12 (= core count) oversubscribes because the
  mock server also wants cores, and 24 is markedly worse. **8 is the sweet spot.**
- **`maxInFlight`** (per-run, open-loop) - the dispatch hard cap. The default
  `max(targetRps × 10, 1000)` is effectively unbounded at high target RPS and
  causes congestion collapse (in-flight balloons to tens of thousands, multi-second
  queue latency, throughput *halves*). Bound it to **~256–500** for clean,
  low-latency saturation. Closed-loop constant-concurrency avoids the issue entirely.
- `eventLoopMaxConcurrent` / `eventLoopMaxPerHost` -
  secondary; effects are within run-to-run noise once the above are set.

## Reproduce it

```bash
# 1. Start the mock server (separate terminal)
go run scripts/test/mock-server.go            # listens on :8080

# 2. Start the engine daemon
engine/build/vayu-engine --port 9876 --data-dir engine/data

# 3. Run the comparison (requires wrk + vegeta on PATH)
bash scripts/test/bench-compare.sh            # prints the markdown table

# tunables via env: URL=... DUR=12 CONCS="64 128 256" WORKERS=8
```
