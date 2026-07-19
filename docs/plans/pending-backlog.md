# Vayu - Pending Backlog

Living backlog of deferred / surfaced work. Each item notes **why** it's pending and **what** it needs so it can be picked up as a focused plan.

_Last updated: 2026-07-19. Recently shipped and removed from this list: **W1** (windowed percentiles) via PR #54; **N3** (uPlot chart unification) + the four-category app-settings overhaul via PR #55 (0.8.0); **P2** (`/config` validation message) via PR #50._

---

## Engine performance / stability (surfaced 2026-06-05 high-RPS investigation)

### P1. High-RPS worker/connection defaults
Against `/fast` on loopback, tuned Vayu reaches ~45k req/s (vs `wrk` ~51k), but the **defaults collapse it to ~11–27k**:
- `workers = ncpu` over-subscribes the busy-poll worker threads → throughput scales to ~9 workers then **collapses** at `ncpu` (no cores left for the strategy-producer + co-located target). Sweet spot ≈ `ncpu − 2/3`.
- `eventLoopMaxPerHost` is applied **per worker**, so effective host connections = `workers × maxPerHost` - over-provisions past the loopback sweet spot.
- `maxInFlight` default (`target × 10`) is effectively unbounded → backlog balloons (390k) instead of shedding load.

**Needs:** lower the default `workers`; make the connection cap a **global budget** (or auto-derive from workers); bound the default `maxInFlight`. (Confirmed PR #10 is NOT the cause; ceiling is long-standing architecture. The branch-only 12-worker collapse was traced to added per-completion CPU and only bites at `workers=ncpu`.) Needs a spec.

### P3. Remaining flat-error routes swallowed by the app client _(surfaced 2026-07-18 during P2)_
The generic `send_error` helper (`routes.hpp:39`) emits flat `{"error":"<string>"}`, but `http-client.ts` only reads the nested `error.message`/`error.code`. Every route still using the flat helper (e.g. `config.cpp`'s "Invalid JSON", `execution.cpp:287/456`, `health`, 500 fallbacks) therefore shows a bare `HTTP <status>` in the UI, dropping the message. P2 fixed only the `/config` validation path. **Needs:** either migrate `send_error` to the nested shape (audit all call sites - some may rely on the flat body) or teach the client to accept both. Small, but cross-cutting. Low priority - most of these are developer-facing.

---

## Janitorial

### N2. Lint sweep
~120 ESLint findings in the app (mostly `@typescript-eslint/no-explicit-any` + misc). Janitorial; no behaviour change.

---

## Parked (revisit only if the trigger becomes real)

### D8. HdrHistogram concurrent read/write - _mitigated by W1; cumulative-path atomic cure intentionally deferred_
`get_current_stats()` read the histogram lock-free while workers record. **W1 mitigated this:** the live percentile path now reads the phaser-based `hdr_interval_recorder` (race-free by construction), and the cumulative histogram is no longer read concurrently on the live path — `calculate_percentiles()` runs post-run after workers stop. The literal cure (switch cumulative recording to `hdr_record_value_atomic`) is **intentionally not applied**: it adds a CAS per sample on the 60k+ RPS hot path (works against P1) for a race that is benign on every arch Vayu ships (x86_64 / Apple Silicon / Linux arm64 all have atomic 64-bit reads). Revisit only if a 32-bit / non-atomic-64-bit-read arch becomes a target — and pair it with a hot-path benchmark.

### D9. RampUp `ramp_lag` baseline for `start=0`
A `startConcurrency=0` ramp shows ~0.8% structural lag on a healthy run (integer truncation vs real-valued integral). Far below the >5% real-stall threshold; signal intact. Optional cure: floor `startConcurrency` to 1 at the UI/validation layer (not the engine).

---

## Open questions

- **cpp-httplib FD_SETSIZE fix - status unclear.** No `FD_SETSIZE`/`CPPHTTPLIB_` reference exists anywhere in `engine/` on current master, despite an earlier "Shipped" note claiming it landed. Re-verify whether the high-FD ceiling is actually addressed before relying on it.
