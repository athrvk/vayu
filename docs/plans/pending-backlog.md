# Vayu - Pending Backlog

Living backlog of deferred / surfaced work. Each item notes **why** it's pending and **what** it needs so it can be picked up as a focused plan.

_Last updated: 2026-07-20. Recently shipped and removed from this list: **W1** (windowed percentiles) via PR #54; **N3** (uPlot chart unification) + the four-category app-settings overhaul via PR #55 (0.8.0); **P2** (`/config` validation message) via PR #50._

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

## MCP

### M1. Package the stdio MCP server as a `vayu mcp` bin

The stdio MCP server (`app/electron/mcp/cli.ts`) is built and tested but is only invocable by full path (`node dist-electron/mcp/cli.js`), which is clunky for stdio-only clients (e.g. Zed's `context_servers`) and headless/CI. **Needs:** expose it as a `vayu mcp` command - a `bin` entry / installer shim - so a client config can use `command: "vayu", args: ["mcp"]` instead of a `dist-electron` path. Ergonomics only; the server itself is complete (reuses the same registry/guards as the HTTP host, config via `VAYU_MCP_*` env vars). Best folded into the app installer/packaging work.

---

## Architecture / maintainability

### A1. Request composition is duplicated across engine clients - consolidate into the engine

Preparing a request before it executes - resolving `{{variables}}`, walking the
collection chain for `inherit` auth, and composing the collection-chain + request
pre/post scripts - used to happen **client-side, once per engine client**.

**Script slice: done.** The engine now accepts an ordered list of script parts
(`{ origin: "collection" | "request", id?, name?, script }` -
`preRequestScripts` / `postRequestScripts` on `POST /execute`, `tests` on
`POST /runs`) and joins them with `"\n\n"` itself, dropping any part whose script
is empty or only whitespace (`engine/src/http/script_parts.cpp`). Both clients
still *build* that ordered list client-side (root-to-leaf chain, then the
request's own) - `app/src/modules/request-builder/utils/script-parts.ts` and the
`scriptParts` helper in `app/electron/mcp/resolve.ts` - but no longer join the
strings together, so a stored run can say which part came from where and a
collection's script can no longer end up glued into a saved request. See
`docs/engine/mcp.md` → *Request composition* and `docs/engine/architecture.md` →
*Request composition boundary*.

**Still open: `{{variable}}` interpolation and `inherit`-auth resolution.**
These remain **client-side, once per engine client**:

- **Renderer:** `app/src/hooks/useVariableResolver.ts` + inline in
  `app/src/modules/request-builder/index.tsx` (execute + load paths) +
  `app/src/modules/request-builder/utils/auth-resolution.ts`.
- **MCP:** `app/electron/mcp/resolve.ts` - a faithful port of the renderer
  pipeline (added when MCP became a second engine client; see PR / `mcp.md`).

**Root cause - the engine already does most of composition but stops short.**
On `POST /execute` (`engine/src/http/routes/execution.cpp`) it loads the
environment, globals, and the request's collection variables (into the script
context), applies concrete auth (`build_request` → `apply_auth`, incl. the OAuth2
token cache), and now joins and runs the pre/post script parts. It does **not**
interpolate `{{var}}` into the URL/headers/body or resolve `inherit` auth from
the collection chain - and it takes auth/scripts from the POST body rather than
from the saved request. It even drops `{"mode":"inherit"}` explicitly as
"resolved app-side" (`auth_resolver.cpp::parse_auth`). So every client fills that
gap itself, which is why the logic is duplicated.

**Direction (NOT yet actioned - documented for awareness).** Finish composition
in the engine: an "execute a saved request by id, fully composed" path that
interpolates variables and walks the inherit-auth chain, reusing the maps +
auth machinery it already has (the script machinery is already reused, per the
slice above). Then MCP drops its remaining composition entirely (hands the
engine `requestId` + `environmentId`), and the renderer can adopt it for **send**
while keeping `useVariableResolver` only for live UI preview/highlighting - a
genuinely separate concern. The codebase already accepts this TS-preview /
C++-execution split (see the `castByType` mirror note in
`app/src/lib/variable-cast.ts`).

**Cost / why deferred.** Substantial new C++ in the AGPL engine (+ gtest
coverage), and it touches the renderer's untested send/load path; it reverses the
"keep the engine untouched" scoping held during the MCP work. **Until it is done,
treat `resolve.ts` and the renderer pipeline as a known, intentional duplicate
that must stay behaviorally in sync - do NOT add a third client-side copy.** A new
engine client should reuse `app/electron/mcp/resolve.ts` (or the engine path once
it exists). Parity is currently guarded only by `resolve.test.ts` + the renderer's
own tests. See `docs/engine/mcp.md` → *Request composition* and
`docs/engine/architecture.md` → *Request composition boundary*.

---

## Parked (revisit only if the trigger becomes real)

### D8. HdrHistogram concurrent read/write - _mitigated by W1; cumulative-path atomic cure intentionally deferred_

`get_current_stats()` read the histogram lock-free while workers record. **W1 mitigated this:** the live percentile path now reads the phaser-based `hdr_interval_recorder` (race-free by construction), and the cumulative histogram is no longer read concurrently on the live path - `calculate_percentiles()` runs post-run after workers stop. The literal cure (switch cumulative recording to `hdr_record_value_atomic`) is **intentionally not applied**: it adds a CAS per sample on the 60k+ RPS hot path (works against P1) for a race that is benign on every arch Vayu ships (x86_64 / Apple Silicon / Linux arm64 all have atomic 64-bit reads). Revisit only if a 32-bit / non-atomic-64-bit-read arch becomes a target - and pair it with a hot-path benchmark.

### D9. RampUp `ramp_lag` baseline for `start=0`

A `startConcurrency=0` ramp shows ~0.8% structural lag on a healthy run (integer truncation vs real-valued integral). Far below the >5% real-stall threshold; signal intact. Optional cure: floor `startConcurrency` to 1 at the UI/validation layer (not the engine).

---

## Open questions

- **cpp-httplib FD_SETSIZE fix - status unclear.** No `FD_SETSIZE`/`CPPHTTPLIB_` reference exists anywhere in `engine/` on current master, despite an earlier "Shipped" note claiming it landed. Re-verify whether the high-FD ceiling is actually addressed before relying on it.
