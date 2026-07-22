# Design Run Detached Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a design run in History opens a copy of the request that was sent, which you can read, edit and send again, without touching your saved request.

**Architecture:** The run tab keeps its existing type. It renders the request builder with starting values taken from the run, and with no save callback, so nothing is written anywhere. The engine gains one field on `GET /run/:id` and takes script parts as a list instead of one pre-joined string, so a stored run can say what actually ran and where each part came from.

**Tech Stack:** C++20 engine (CMake, vcpkg, Google Test), Electron + React + TypeScript app (Vitest, TanStack Query, Zustand, Tailwind v4).

**Spec:** `docs/plans/2026-07-22-design-run-detached-copy.md`. Read it before starting. Every fact in it was checked against a running engine.

**Branch:** `design-run-detached-copy`, cut fresh from master.

## Global Constraints

- **No em-dashes anywhere in the repo.** Use `-`. Applies to code, comments, tests, docs and commit messages.
- **Tests default to the `node` environment.** A test that renders, or touches `document` / `window` / `localStorage`, must start with `/**\n * @vitest-environment jsdom\n */`.
- **A test must never assert the host platform.** CI runs Linux, macOS and Windows.
- **No bare `rounded`** in class lists; it ignores the Roundedness setting. No radius class at all is the same bug pointing the other way.
- **Write `border-rule`, not a border token**, when a divider sits inside a surface. The surface class (`surface-card`, `surface-sunken`) declares what it resolves to.
- **A `Badge` that paints its own `bg-` must be `variant="chip"`.**
- **Never run prettier or `eslint --fix` across the repo.** Format only files you touched that were already clean.
- **Do not add a third copy of request composition.** Renderer and MCP are a known, intentional duplicate that must change together.
- **Mutation-check every behavioural test:** revert the fix, confirm the test fails, restore it.
- **Source-scanning tests must assert they read something non-empty.** Vitest stubs CSS imports to `""`.
- **If you change something a doc describes, update that doc in the same commit.**

**Commands used throughout:**

| Purpose                 | Command                                                       |
| ----------------------- | ------------------------------------------------------------- |
| One frontend test file  | `cd app && pnpm vitest run <path>`                            |
| Full frontend suite     | `cd app && pnpm test`                                         |
| Types                   | `cd app && pnpm type-check`                                   |
| Format one file         | `cd app && pnpm exec prettier --write <path>`                 |
| Build engine with tests | `python build.py -t`                                          |
| Engine tests            | `cd engine && ctest --preset windows-dev --output-on-failure` |

Substitute `linux-dev` or `macos-dev` for the preset on those platforms.

---

# Phase 0: standalone fixes

These three are worth doing even if the rest is never built. They can ship on their own.

---

### Task 1: Rebuild the raw request from a stored trace

Today the restore path turns a whole trace into `` `${method} ${url}` ``, so the Raw tab of a reopened run is one line and the body that was sent is not reachable anywhere in the app.

**Files:**

- Modify: `app/src/components/shared/response-viewer/utils.ts` (add next to `buildRawResponse`)
- Modify: `app/src/components/shared/response-viewer/index.ts` (export it)
- Modify: `app/src/modules/request-builder/utils/restore-response.ts:88`
- Modify: `app/src/modules/request-builder/utils/restore-response.test.ts`
- Test: `app/src/components/shared/response-viewer/build-raw-request.test.ts` (create)

**Interfaces:**

- Produces: `buildRawRequest(method: string, url: string, headers?: Record<string, string>, body?: string): string`

- [ ] **Step 1: Write the failing test**

Create `app/src/components/shared/response-viewer/build-raw-request.test.ts`:

```ts
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The raw request shown for a stored run.
 *
 * A live send gets this string from the engine, which builds the real wire
 * message. A restored one has to rebuild it from the four fields the trace
 * stores, and the two are read in the same tab, so the shape has to match
 * `build_raw_request` in engine/src/http/client.cpp.
 */

import { describe, it, expect } from "vitest";
import { buildRawRequest } from "./utils";

describe("buildRawRequest", () => {
  it("uses the path, not the whole URL, and takes Host from the URL", () => {
    expect(
      buildRawRequest("GET", "https://api.example.test/v1/users?page=2"),
    ).toBe("GET /v1/users?page=2 HTTP/1.1\r\nHost: api.example.test\r\n\r\n");
  });

  it("keeps the port, which is part of the host", () => {
    expect(buildRawRequest("GET", "http://127.0.0.1:8080/health")).toContain(
      "Host: 127.0.0.1:8080\r\n",
    );
  });

  it("gives a bare origin the root path", () => {
    expect(buildRawRequest("GET", "https://example.test")).toMatch(
      /^GET \/ HTTP\/1\.1\r\n/,
    );
  });

  it("does not print Host twice when the trace already has one", () => {
    const raw = buildRawRequest("GET", "https://example.test/", {
      Host: "example.test",
      Accept: "*/*",
    });

    expect(raw.match(/^Host:/gm)).toHaveLength(1);
    expect(raw).toContain("Accept: */*\r\n");
  });

  it("adds Content-Length and the body after a blank line", () => {
    expect(buildRawRequest("POST", "https://example.test/x", {}, "hi")).toBe(
      "POST /x HTTP/1.1\r\nHost: example.test\r\nContent-Length: 2\r\n\r\nhi",
    );
  });

  it("counts Content-Length in bytes, not characters", () => {
    // The engine counts content.size(). "é" is one character and two bytes.
    expect(buildRawRequest("POST", "https://e.test/", {}, "é")).toContain(
      "Content-Length: 2\r\n",
    );
  });

  it("omits Content-Length when there is no body", () => {
    expect(buildRawRequest("GET", "https://example.test/")).not.toContain(
      "Content-Length",
    );
  });

  it("keeps a URL it cannot parse whole", () => {
    const raw = buildRawRequest("GET", "{{base}}/users");

    expect(raw).toBe("GET {{base}}/users HTTP/1.1\r\n\r\n");
    expect(raw).not.toContain("Host:");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && pnpm vitest run src/components/shared/response-viewer/build-raw-request.test.ts`
Expected: FAIL, `buildRawRequest is not a function`.

- [ ] **Step 3: Implement it**

In `app/src/components/shared/response-viewer/utils.ts`, add directly above `buildRawResponse`:

```ts
/**
 * Rebuild the raw HTTP request from the parts a stored trace keeps.
 *
 * A live send gets `rawRequest` from the engine, which assembles the real wire
 * message (`build_raw_request`, engine/src/http/client.cpp). A restored one has
 * no such string - the trace stores method, url, headers and body separately -
 * and the restore path used to collapse all four into `${method} ${url}`, so
 * the Raw tab of a reopened run showed a single line and the body that was sent
 * was not reachable anywhere in the app.
 *
 * This follows the engine's order so the two read the same: request line with
 * the path, `Host` from the URL, the sent headers, `Content-Length` for a body,
 * blank line, body.
 */
export function buildRawRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): string {
  let target = url;
  let host = "";
  try {
    const parsed = new URL(url);
    target = `${parsed.pathname}${parsed.search}` || "/";
    host = parsed.host;
  } catch {
    // A URL the platform will not parse - a host with no scheme, or one
    // still holding an unresolved {{variable}}. Keep the string whole rather
    // than inventing a split, and let the Host header fall away with it.
  }

  let raw = `${method || "GET"} ${target} HTTP/1.1\r\n`;
  if (host) raw += `Host: ${host}\r\n`;

  for (const [key, value] of Object.entries(headers)) {
    // Host comes from the URL above; printing it twice is a protocol error.
    if (key.toLowerCase() === "host") continue;
    raw += `${key}: ${value}\r\n`;
  }

  // Bytes, not characters - the engine counts `content.size()`, and any
  // non-ASCII in the body makes the two differ.
  if (body)
    raw += `Content-Length: ${new TextEncoder().encode(body).length}\r\n`;

  raw += "\r\n";
  if (body) raw += body;

  return raw;
}
```

In `app/src/components/shared/response-viewer/index.ts`, change the utils export block to include it:

```ts
export {
  detectBodyType,
  formatBody,
  formatSize,
  getMonacoLanguage,
  buildRawRequest,
  buildRawResponse,
} from "./utils";
```

- [ ] **Step 4: Run the test again**

Run: `cd app && pnpm vitest run src/components/shared/response-viewer/build-raw-request.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Use it on the restore path**

In `app/src/modules/request-builder/utils/restore-response.ts`, add the import at the top:

```ts
import { buildRawRequest } from "@/components/shared/response-viewer";
```

Replace the `rawRequest` line (currently line 88):

```ts
		rawRequest: trace.request ? `${trace.request.method} ${trace.request.url}` : undefined,
```

with:

```ts
		rawRequest: trace.request
			? buildRawRequest(
					trace.request.method || "GET",
					trace.request.url || "",
					trace.request.headers || {},
					trace.request.body
				)
			: undefined,
```

- [ ] **Step 6: Update the restore test**

In `app/src/modules/request-builder/utils/restore-response.test.ts`, delete this line from the "still restores status, headers and body" test:

```ts
expect(restored?.rawRequest).toBe("GET https://api.example.test/users");
```

Add a new test after it:

```ts
/**
 * The Raw tab answers "what did I actually send", and the request pane
 * beside it cannot - it shows the request as it is now, possibly edited
 * since the run. This used to collapse the whole trace to `GET <url>`, so
 * a reopened run showed one line and the body that was sent was not
 * reachable anywhere in the app.
 */
it("rebuilds a real raw request, not a method-and-url line", () => {
  const restored = responseFromRunResult(
    sample({
      trace: {
        request: {
          method: "POST",
          url: "https://api.example.test/users?dry=1",
          headers: { "content-type": "application/json" },
          body: '{"name":"ada"}',
        },
        response: { headers: {}, body: "{}" },
      },
    }),
  );

  expect(restored?.rawRequest).toBe(
    "POST /users?dry=1 HTTP/1.1\r\n" +
      "Host: api.example.test\r\n" +
      "content-type: application/json\r\n" +
      "Content-Length: 14\r\n" +
      "\r\n" +
      '{"name":"ada"}',
  );
});
```

- [ ] **Step 7: Run both test files**

Run: `cd app && pnpm vitest run src/modules/request-builder/utils/restore-response.test.ts src/components/shared/response-viewer/build-raw-request.test.ts`
Expected: PASS.

- [ ] **Step 8: Types and format**

Run: `cd app && pnpm type-check`
Expected: no output.

Run: `cd app && pnpm exec prettier --write src/components/shared/response-viewer/utils.ts src/components/shared/response-viewer/index.ts src/components/shared/response-viewer/build-raw-request.test.ts src/modules/request-builder/utils/restore-response.ts src/modules/request-builder/utils/restore-response.test.ts`

- [ ] **Step 9: Commit**

```bash
git add app/src/components/shared/response-viewer app/src/modules/request-builder/utils
git commit -m "fix(app): rebuild a real raw request when restoring a stored run

The restore path collapsed a whole trace into \`\${method} \${url}\`, so the
Raw tab of a reopened run was one line and the body that was sent was not
reachable anywhere in the app. buildRawRequest follows the engine's own
assembly (client.cpp), so the restored string and the live one read the
same."
```

---

### Task 2: Restore runs that failed before reaching a server

A request that never reached a server stores no `response` in its trace, only `error_type` and `error_message`. `responseFromRunResult` returns `null` for those, so the pane shows nothing at all.

**Files:**

- Modify: `app/src/types/domain.ts` (the results trace type)
- Modify: `app/src/modules/request-builder/utils/restore-response.ts`
- Modify: `app/src/modules/request-builder/utils/restore-response.test.ts`

**Interfaces:**

- Consumes: `buildRawRequest` from Task 1.
- Produces: `responseFromRunResult` now returns a `status: 0` `ResponseState` for failed runs, carrying `errorCode` and `errorMessage`.

- [ ] **Step 1: Add the missing field to the trace type**

In `app/src/types/domain.ts`, inside the `results` array's `trace` object, replace:

```ts
				error_type?: string;
				message?: string;
```

with:

```ts
				/** `to_string(ErrorCode)` - the same words a live `errorCode` uses. */
				error_type?: string;
				/** The load-test writer's failure text (`load_strategy.cpp`). */
				message?: string;
				/** The design-mode writer's failure text (`store_result`, execution.cpp). */
				error_message?: string;
```

- [ ] **Step 2: Write the failing tests**

Append to the `describe("responseFromRunResult", ...)` block in `app/src/modules/request-builder/utils/restore-response.test.ts`:

```ts
/**
 * A request that never reached a server stores no `response` node at all -
 * `store_result` writes `error_type`/`error_message` instead. Returning null
 * left the response pane blank, which was survivable while a second viewer
 * showed the error in its own callout. Once the builder is the only place a
 * design run is displayed, the failure has to arrive with it.
 */
describe("a run that failed before reaching the server", () => {
  const failed = sample({
    statusCode: 0,
    statusText: "",
    trace: {
      request: {
        method: "GET",
        url: "https://nope.example.test/",
        headers: {},
      },
      error_type: "CONNECTION_FAILED",
      error_message: "Could not connect to host",
      dnsMs: 12,
    },
  });

  it("maps to the same status-0 shape a live failure produces", () => {
    const restored = responseFromRunResult(failed);

    // status 0 is what sends the pane to ClientErrorView, and errorCode
    // picks its icon and hint. The engine's `to_string(ErrorCode)` uses
    // the same words as a live `errorCode`.
    expect(restored?.status).toBe(0);
    expect(restored?.errorCode).toBe("CONNECTION_FAILED");
    expect(restored?.errorMessage).toBe("Could not connect to host");
  });

  it("still carries what was sent, and the phases that got as far as they did", () => {
    const restored = responseFromRunResult(failed);

    expect(restored?.rawRequest).toContain("GET / HTTP/1.1");
    expect(restored?.timing?.dns).toBe(12);
  });

  it("falls back to the result's own error text", () => {
    // Older rows, and the load-test writer, do not fill `error_message`.
    const restored = responseFromRunResult(
      sample({
        error: "Timeout was reached",
        trace: { error_type: "TIMEOUT" },
      }),
    );

    expect(restored?.errorMessage).toBe("Timeout was reached");
  });
});
```

Change the existing null test's name and leave its body alone:

```ts
	it("returns null when the run result carries neither an exchange nor an error", () => {
```

- [ ] **Step 3: Run and confirm it fails**

Run: `cd app && pnpm vitest run src/modules/request-builder/utils/restore-response.test.ts`
Expected: FAIL, the failed-run tests get `null`.

- [ ] **Step 4: Implement**

In `app/src/modules/request-builder/utils/restore-response.ts`, add this helper above `responseFromRunResult`:

```ts
/**
 * The parts of a restored response that are the same whether the run succeeded
 * or failed: what was sent.
 */
function sentSide(trace: NonNullable<RunResultSample["trace"]>) {
  const request = trace.request;
  return {
    requestHeaders: request?.headers || {},
    rawRequest: request
      ? buildRawRequest(
          request.method || "GET",
          request.url || "",
          request.headers || {},
          request.body,
        )
      : undefined,
  };
}
```

Replace the body of `responseFromRunResult` with:

```ts
export function responseFromRunResult(
  result: RunResultSample | undefined,
): ResponseState | null {
  const trace = result?.trace;
  if (!result || !trace) return null;

  /*
   * A request that never reached a server stores no `response` node -
   * `store_result` writes `error_type`/`error_message` instead. Mapping it to
   * the same status-0 shape a live failure produces is what lets the builder's
   * `ClientErrorView` render it, icon, hint and code included. `error_type`
   * uses the same words as the live `errorCode` (`to_string(ErrorCode)` in
   * engine/include/vayu/types.hpp).
   */
  if (!trace.response) {
    const errorMessage = trace.error_message || result.error;
    if (!trace.error_type && !errorMessage) return null;

    return {
      status: 0,
      statusText: result.statusText || "Error",
      headers: {},
      ...sentSide(trace),
      body: errorMessage || "",
      bodyType: "text",
      size: 0,
      time: result.latencyMs || 0,
      timing: timingFromTrace(trace, result.latencyMs),
      errorCode: trace.error_type,
      errorMessage,
    };
  }

  const raw = trace.response.body;
  const body =
    typeof raw === "string"
      ? raw
      : raw === undefined
        ? ""
        : JSON.stringify(raw, null, 2);

  return {
    status: result.statusCode || 0,
    statusText: result.statusText || "",
    headers: trace.response.headers || {},
    ...sentSide(trace),
    body,
    bodyType: detectBodyType(body),
    size: body.length,
    time: result.latencyMs || 0,
    timing: timingFromTrace(trace, result.latencyMs),
    timestamp: new Date(result.timestamp).toISOString(),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd app && pnpm vitest run src/modules/request-builder/utils/restore-response.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation-check**

Temporarily change `if (!trace.error_type && !errorMessage) return null;` to `return null;` and rerun. The three failed-run tests must fail. Restore the line.

- [ ] **Step 7: Types, format, commit**

```bash
cd app && pnpm type-check
cd app && pnpm exec prettier --write src/types/domain.ts src/modules/request-builder/utils/restore-response.ts src/modules/request-builder/utils/restore-response.test.ts
cd .. && git add app/src/types/domain.ts app/src/modules/request-builder/utils
git commit -m "fix(app): restore a design run that failed before reaching the server

Such a run stores no response node, only error_type and error_message, and
the restore path returned null for it - so the pane showed nothing at all.
It now maps to the same status-0 shape a live failure produces, which is
what routes it to ClientErrorView with its icon, hint and code."
```

---

### Task 3: Say when a restored response is from a past run

The builder rebuilds the last design run's response on startup and does not say so. `ResponseState.timestamp` was written for this and read by nothing.

**Files:**

- Modify: `app/src/modules/request-builder/types.ts`
- Modify: `app/src/stores/response-store.ts`
- Modify: `app/src/modules/request-builder/utils/restore-response.ts`
- Modify: `app/src/modules/request-builder/context/RequestBuilderProvider.tsx`
- Modify: `app/src/components/shared/response-viewer/ResponseStatusBar.tsx`
- Modify: `app/src/modules/request-builder/components/ResponseViewer/index.tsx`
- Test: `app/src/components/shared/response-viewer/response-age.test.tsx` (create)

**Interfaces:**

- Produces: `RestoredFrom { runId?: string; at: string }` exported from `app/src/modules/request-builder/types.ts`. `responseFromRunResult(result, runId?)` gains a second parameter. `ResponseStatusBarProps` gains `restoredFrom?: { runId?: string; at: string }`.

- [ ] **Step 1: Write the failing test**

Create `app/src/components/shared/response-viewer/response-age.test.tsx`:

```tsx
/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A restored response has to look restored.
 *
 * The pane rebuilds the last stored design run on every cold start, and the
 * request editor beside it shows the request as it is now. A response from
 * three days ago and one from three seconds ago rendered identically, so there
 * was no way to tell whether the two halves of the screen described the same
 * exchange. `ResponseState.timestamp` was written for exactly this and read by
 * nothing.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResponseStatusBar } from "./ResponseStatusBar";

const HOUR_MS = 60 * 60 * 1000;

describe("the response age chip", () => {
  it("says how old the run is", () => {
    const at = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    render(
      <ResponseStatusBar status={200} statusText="OK" restoredFrom={{ at }} />,
    );

    expect(screen.getByText(/from run - 2h ago/i)).toBeTruthy();
  });

  it("is absent for a response that was just sent", () => {
    render(
      <ResponseStatusBar status={200} statusText="OK" time={12} size={11} />,
    );

    expect(screen.queryByText(/from run/i)).toBeNull();
  });

  it("carries the exact time and the run id in its tooltip", () => {
    const at = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    const { container } = render(
      <ResponseStatusBar
        status={200}
        restoredFrom={{ at, runId: "run-abc" }}
      />,
    );

    const chip = container.querySelector("[title]") as HTMLElement;
    expect(chip.title).toContain(new Date(at).toLocaleString());
    expect(chip.title).toContain("run-abc");
  });

  it("still renders without a run id", () => {
    const at = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    const { container } = render(
      <ResponseStatusBar status={200} restoredFrom={{ at }} />,
    );

    expect(
      (container.querySelector("[title]") as HTMLElement).title,
    ).not.toContain("Run ");
  });

  it("paints no background, so it is not a Badge needing variant=chip", () => {
    // Every Badge variant but `chip` pairs bg-x with hover:bg-x/80, and
    // tailwind-merge replaces the fill but not the hover. Nothing here is
    // clickable. See badge-hover.test.tsx.
    const at = new Date().toISOString();
    const { container } = render(
      <ResponseStatusBar status={200} restoredFrom={{ at }} />,
    );

    expect(
      (container.querySelector("[title]") as HTMLElement).className,
    ).not.toMatch(/\bbg-/);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd app && pnpm vitest run src/components/shared/response-viewer/response-age.test.tsx`
Expected: FAIL, no element with a `title`.

- [ ] **Step 3: Add the type**

In `app/src/modules/request-builder/types.ts`, add above `export interface ResponseState {`:

```ts
/** Which stored run a response was rebuilt from, and when that run happened. */
export interface RestoredFrom {
  runId?: string;
  /** ISO timestamp of the run result. */
  at: string;
}
```

In the same file, replace `timestamp?: string;` inside `ResponseState` with:

```ts
	/**
	 * Set only when this response was rebuilt from a stored run rather than sent
	 * just now - a cold start, or a run opened from History. Drives the pane's
	 * age chip, which is the only thing that tells the two apart: the request
	 * beside it may have been edited since. Gone after the next send.
	 *
	 * This replaced a bare `timestamp` that had one writer and no reader.
	 */
	restoredFrom?: RestoredFrom;
```

In `app/src/stores/response-store.ts`, replace `timestamp?: string;` inside `StoredResponse` with:

```ts
	/** Set when the response was rebuilt from a stored run - see `ResponseState`. */
	restoredFrom?: { runId?: string; at: string };
```

- [ ] **Step 4: Write it on the restore path**

In `app/src/modules/request-builder/utils/restore-response.ts`, change the signature:

```ts
export function responseFromRunResult(
	result: RunResultSample | undefined,
	runId?: string
): ResponseState | null {
```

Add after the `if (!result || !trace) return null;` line:

```ts
const restoredFrom = { runId, at: new Date(result.timestamp).toISOString() };
```

Add `restoredFrom,` to both returned objects, and delete the `timestamp: new Date(result.timestamp).toISOString(),` line from the success branch.

In `app/src/modules/request-builder/context/RequestBuilderProvider.tsx`, change the query destructure:

```ts
const {
  run: lastDesignRun,
  report: lastDesignRunReport,
  isLoading: isLoadingLastRun,
} = useLastDesignRunQuery(request.id);
```

Change the reconstruction call and its dependency array:

```ts
const restoredResponse = responseFromRunResult(
  lastDesignRunReport?.results?.[0],
  lastDesignRun?.id,
);
```

```ts
	}, [
		request.id,
		response,
		lastDesignRun,
		lastDesignRunReport,
		isLoadingLastRun,
		storeSetResponse,
	]);
```

- [ ] **Step 5: Render the chip**

In `app/src/components/shared/response-viewer/ResponseStatusBar.tsx`, change the imports:

```ts
import { Clock, FileText, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils";
import { formatResponseTime, formatSize } from "./utils";
import { StatusCodeBadge } from "./StatusCodeBadge";
```

Add to `ResponseStatusBarProps`, above `className`:

```ts
	/**
	 * Set when this response was rebuilt from a stored run rather than sent just
	 * now. See the age chip below for why the difference is shown.
	 */
	restoredFrom?: { runId?: string; at: string };
```

Add `restoredFrom,` to the destructured parameters. Add this as the last child inside the wrapper `div`, after the `size` block:

```tsx
{
  /*
   * Response age.
   *
   * Without it, a response restored from a stored run reads exactly
   * like one that just came back, while the request editor beside it
   * shows the request as it is now, possibly edited since. The
   * relative form is what the History sidebar says about the same run;
   * the exact time and the run id go in the tooltip.
   *
   * No `bg-`, so no Badge - see the variant="chip" rule in
   * badge-hover.test.tsx. It is text, and it sits at the far end
   * rather than among status/time/size, which describe the exchange
   * itself.
   */
}
{
  restoredFrom && (
    <div
      className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"
      title={
        `Restored from a stored run - ${new Date(restoredFrom.at).toLocaleString()}` +
        (restoredFrom.runId ? `\nRun ${restoredFrom.runId}` : "")
      }
    >
      <History className="h-3.5 w-3.5" />
      <span>from run - {formatRelativeTime(restoredFrom.at)}</span>
    </div>
  );
}
```

In `app/src/modules/request-builder/components/ResponseViewer/index.tsx`, add `restoredFrom={response.restoredFrom}` to **both** `ResponseStatusBar` usages: the client-error branch and the main one.

- [ ] **Step 6: Run the tests**

Run: `cd app && pnpm vitest run src/components/shared/response-viewer/response-age.test.tsx src/modules/request-builder/utils/restore-response.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, types, format**

Run: `cd app && pnpm test` - expect all pass.
Run: `cd app && pnpm type-check` - expect no output.
Format the six touched files with prettier.

- [ ] **Step 8: Commit**

```bash
git add app/src
git commit -m "feat(app): say when a response came from a past run

The builder rebuilds the last stored design run on startup and said
nothing, so a three-day-old response looked exactly like a fresh one while
the request editor beside it showed the request as it is now.
ResponseState.timestamp existed for this and was read by nothing; it is now
restoredFrom, and the status bar reads it."
```

---

# Phase 1: engine

---

### Task 4: `GET /run/:id` returns the exchange for a design run

The design view needs the run's configuration, which only this endpoint has. It also needs the request and response, which today live only inside the load-shaped report.

**Files:**

- Modify: `engine/src/http/routes/runs.cpp:47-66`
- Test: `engine/tests/run_route_test.cpp` (create)
- Modify: `engine/tests/CMakeLists.txt` or `engine/CMakeLists.txt` (whichever lists test sources)
- Modify: `docs/engine/api-reference.md`
- Modify: `docs/engine/db-schema.md`

**Interfaces:**

- Produces: `GET /run/:id` includes a `result` object when `run.type == design` and the run has at least one stored result. Shape: `{ timestamp, statusCode, statusText, latencyMs, error?, trace? }`.

- [ ] **Step 1: Find where test sources are listed**

Run: `grep -rn "run_manager_test\|script_engine_test" engine/CMakeLists.txt engine/tests/CMakeLists.txt 2>/dev/null`
Note the file and pattern used, and add `run_route_test.cpp` the same way in Step 4.

- [ ] **Step 2: Write the failing test**

Create `engine/tests/run_route_test.cpp`. Follow the include and fixture style of `engine/tests/config_route_test.cpp`, which already exercises a route against a temporary database.

```cpp
// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
//
// GET /run/:id carries the stored exchange for a design run.
//
// A design run IS one request and one response, so the exchange belongs with
// the run. Before this, the only way to read it was GET /run/:id/report, which
// is a load-test aggregate: for a design run its summary is computed from a
// single sample and its metadata carries no configuration at all.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include "vayu/db/database.hpp"
#include "vayu/utils/json.hpp"

namespace {

vayu::db::Run make_run (const std::string& id, vayu::RunType type) {
    vayu::db::Run run;
    run.id              = id;
    run.type            = type;
    run.status          = vayu::RunStatus::Completed;
    run.start_time      = 1;
    run.end_time        = 2;
    run.config_snapshot = R"({"method":"GET","url":"http://x/"})";
    return run;
}

vayu::db::Result make_result (const std::string& run_id) {
    vayu::db::Result r;
    r.run_id      = run_id;
    r.timestamp   = 10;
    r.status_code = 200;
    r.status_text = "OK";
    r.latency_ms  = 2.5;
    r.trace_data  = R"({"request":{"method":"GET","url":"http://x/"},)"
                    R"("response":{"headers":{},"body":"hi"}})";
    return r;
}

} // namespace

TEST (RunRoute, DesignRunCarriesItsResult) {
    // Build the payload the route builds, through the same serializer.
    auto run  = make_run ("run_design", vayu::RunType::Design);
    auto json = vayu::json::serialize (run);
    vayu::json::attach_design_result (json, run, { make_result ("run_design") });

    ASSERT_TRUE (json.contains ("result"));
    EXPECT_EQ (json["result"]["statusCode"], 200);
    EXPECT_EQ (json["result"]["statusText"], "OK");
    EXPECT_EQ (json["result"]["trace"]["response"]["body"], "hi");
}

TEST (RunRoute, LoadRunCarriesNoResult) {
    auto run  = make_run ("run_load", vayu::RunType::Load);
    auto json = vayu::json::serialize (run);
    vayu::json::attach_design_result (json, run, { make_result ("run_load") });

    EXPECT_FALSE (json.contains ("result"));
}

TEST (RunRoute, DesignRunWithNoResultsStaysQuiet) {
    auto run  = make_run ("run_empty", vayu::RunType::Design);
    auto json = vayu::json::serialize (run);
    vayu::json::attach_design_result (json, run, {});

    EXPECT_FALSE (json.contains ("result"));
}
```

- [ ] **Step 3: Build and confirm it fails**

Run: `python build.py -t`
Expected: compile error, `attach_design_result` is not declared.

- [ ] **Step 4: Implement**

Add to `engine/include/vayu/utils/json.hpp`, next to the other `serialize` declarations:

```cpp
/**
 * Attach a design run's single exchange to its serialized run object.
 *
 * A design run is one request and one response, so the exchange belongs with
 * the run rather than inside `GET /run/:id/report` - that report is a load-test
 * aggregate whose summary, for a design run, is computed from one sample.
 *
 * Does nothing for a load run, where `results` means the sampled subset and
 * belongs in the report. Does nothing when there are no results.
 */
void attach_design_result (nlohmann::json& json,
const vayu::db::Run& run,
const std::vector<vayu::db::Result>& results);
```

Add to `engine/src/utils/json.cpp`, below `serialize (const vayu::db::Run&)`:

```cpp
void attach_design_result (nlohmann::json& json,
const vayu::db::Run& run,
const std::vector<vayu::db::Result>& results) {
    if (run.type != vayu::RunType::Design || results.empty ())
        return;

    const auto& result = results.front ();
    nlohmann::json out;
    out["timestamp"]  = result.timestamp;
    out["statusCode"] = result.status_code;
    out["statusText"] = result.status_text;
    out["latencyMs"]  = result.latency_ms;
    if (!result.error.empty ())
        out["error"] = result.error;
    if (!result.trace_data.empty ()) {
        try {
            out["trace"] = nlohmann::json::parse (result.trace_data);
        } catch (...) {
            out["trace"] = result.trace_data;
        }
    }
    json["result"] = out;
}
```

In `engine/src/http/routes/runs.cpp`, inside the `GET /run/:id` handler, replace:

```cpp
                res.set_content (vayu::json::serialize (*run).dump (), "application/json");
```

with:

```cpp
                auto payload = vayu::json::serialize (*run);
                // A design run is one exchange, so it travels with the run.
                // Load runs keep theirs in the report, where `results` means
                // the sampled subset.
                vayu::json::attach_design_result (
                payload, *run, ctx.db.get_results (run_id));
                res.set_content (payload.dump (), "application/json");
```

Add `run_route_test.cpp` to the test source list found in Step 1.

- [ ] **Step 5: Build and run the engine tests**

Run: `python build.py -t`
Run: `cd engine && ctest --preset windows-dev --output-on-failure -R RunRoute`
Expected: 3 tests pass.

- [ ] **Step 6: Check it against a running engine**

```bash
./engine/build/vayu-engine.exe --port 9890 --data-dir /tmp/vayu-t &
sleep 5
curl -s -X POST http://127.0.0.1:9890/request -H "Content-Type: application/json" \
  -d '{"method":"GET","url":"http://127.0.0.1:9890/health"}' > /dev/null
RID=$(curl -s http://127.0.0.1:9890/runs | python -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")
curl -s "http://127.0.0.1:9890/run/$RID" | python -m json.tool
```

Expected: a `result` object with `trace.request` and `trace.response`. Stop the engine **by PID**, not by image name - killing every `vayu-engine.exe` will take down the one your app is using.

- [ ] **Step 7: Update the docs**

In `docs/engine/api-reference.md`, under `### GET /run/:runId`, replace "**Response:** Run object with full details." with a description of the run object and a note that design runs also carry `result`, with the JSON shape. In `docs/engine/db-schema.md`, note under `results` that a design run's single row is served by `GET /run/:id` as well as by the report.

- [ ] **Step 8: Commit**

```bash
git add engine/src engine/include engine/tests docs/engine
git commit -m "feat(engine): GET /run/:id carries a design run's exchange

A design run is one request and one response, so the exchange belongs with
the run. The only way to read it before was GET /run/:id/report, which is a
load-test aggregate - for a design run its summary comes from a single
sample and its metadata carries no configuration at all. Load runs are
unchanged; their results are the sampled subset and stay in the report."
```

---

### Task 5: `POST /request` takes script parts

**Files:**

- Modify: `engine/src/http/routes/execution.cpp:305-307`
- Test: `engine/tests/script_compose_test.cpp` (create)
- Modify: the test source list from Task 4 Step 1
- Modify: `docs/engine/api-reference.md`, `docs/engine/scripting.md`

**Interfaces:**

- Produces: a free function in `execution.cpp`'s anonymous namespace, `read_script(const nlohmann::json&, const char* list_key, const char* legacy_key) -> std::string`. Exposed for tests via `engine/include/vayu/http/script_parts.hpp`.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/script_compose_test.cpp`:

```cpp
// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
//
// Script parts arrive as a list and the engine joins them.
//
// The clients used to join them and send one string, which meant a stored run
// could not say which part came from where. The join itself must not change:
// the parts are run as ONE script, so a `const` in a collection's part is
// visible to the request's part, and error line numbers are counted from the
// start of the joined text.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include "vayu/http/script_parts.hpp"

using vayu::http::read_script;

TEST (ScriptParts, JoinsPartsWithABlankLine) {
    auto json = nlohmann::json::parse (R"({
      "preRequestScripts": [
        {"origin":"collection","id":"c1","name":"API","script":"const a = 1;"},
        {"origin":"request","id":"r1","script":"console.log(a);"}
      ]
    })");

    EXPECT_EQ (read_script (json, "preRequestScripts", "preRequestScript"),
    "const a = 1;\n\nconsole.log(a);");
}

TEST (ScriptParts, TheListWinsOverTheLegacyString) {
    auto json = nlohmann::json::parse (R"({
      "preRequestScripts": [{"origin":"request","script":"new"}],
      "preRequestScript": "old"
    })");

    EXPECT_EQ (read_script (json, "preRequestScripts", "preRequestScript"), "new");
}

TEST (ScriptParts, TheLegacyStringStillWorks) {
    auto json = nlohmann::json::parse (R"({"preRequestScript":"only"})");

    EXPECT_EQ (read_script (json, "preRequestScripts", "preRequestScript"), "only");
}

TEST (ScriptParts, DropsPartsThatAreOnlyWhitespace) {
    // The renderer kept these and MCP dropped them. One rule now: drop.
    auto json = nlohmann::json::parse (R"({
      "preRequestScripts": [
        {"origin":"collection","script":"   "},
        {"origin":"request","script":"real"}
      ]
    })");

    EXPECT_EQ (read_script (json, "preRequestScripts", "preRequestScript"), "real");
}

TEST (ScriptParts, MissingEmptyAndAllBlankAllMeanNoScript) {
    auto missing = nlohmann::json::parse (R"({})");
    auto empty   = nlohmann::json::parse (R"({"preRequestScripts":[]})");
    auto blank =
    nlohmann::json::parse (R"({"preRequestScripts":[{"origin":"request","script":"  "}]})");

    EXPECT_EQ (read_script (missing, "preRequestScripts", "preRequestScript"), "");
    EXPECT_EQ (read_script (empty, "preRequestScripts", "preRequestScript"), "");
    EXPECT_EQ (read_script (blank, "preRequestScripts", "preRequestScript"), "");
}

TEST (ScriptParts, KeepsOrder) {
    auto json = nlohmann::json::parse (R"({
      "preRequestScripts": [
        {"origin":"collection","script":"1"},
        {"origin":"collection","script":"2"},
        {"origin":"request","script":"3"}
      ]
    })");

    EXPECT_EQ (read_script (json, "preRequestScripts", "preRequestScript"), "1\n\n2\n\n3");
}
```

- [ ] **Step 2: Build and confirm it fails**

Run: `python build.py -t`
Expected: `vayu/http/script_parts.hpp` not found.

- [ ] **Step 3: Implement**

Create `engine/include/vayu/http/script_parts.hpp`:

```cpp
// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace vayu::http {

/**
 * Read a script from a run payload.
 *
 * Two forms are accepted. `list_key` is a list of parts, each recording the
 * collection or request it came from; the engine joins them. `legacy_key` is
 * the older single pre-joined string, kept because the engine is a standalone
 * binary with a documented HTTP API. The list wins when both are sent; they are
 * never merged.
 *
 * Parts are joined with "\n\n" and the result is run as ONE script, so a
 * `const` declared in a collection's part is visible to the request's part. Do
 * not run the parts separately, and do not change the separator: a syntax error
 * reports a line number counted from the start of the joined text.
 *
 * Parts that are empty or only whitespace are dropped. The renderer used to
 * keep them and MCP used to drop them; this is now the single rule.
 */
std::string read_script (const nlohmann::json& json, const char* list_key, const char* legacy_key);

} // namespace vayu::http
```

Create `engine/src/http/script_parts.cpp`:

```cpp
// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.

#include "vayu/http/script_parts.hpp"

namespace vayu::http {

namespace {

bool is_blank (const std::string& s) {
    return s.find_first_not_of (" \t\r\n") == std::string::npos;
}

} // namespace

std::string read_script (const nlohmann::json& json, const char* list_key, const char* legacy_key) {
    if (auto it = json.find (list_key); it != json.end () && it->is_array ()) {
        std::string joined;
        for (const auto& part : *it) {
            if (!part.is_object ())
                continue;
            const auto script = part.value ("script", std::string{});
            if (is_blank (script))
                continue;
            if (!joined.empty ())
                joined += "\n\n";
            joined += script;
        }
        return joined;
    }
    return json.value (legacy_key, std::string{});
}

} // namespace vayu::http
```

In `engine/src/http/routes/execution.cpp`, add the include near the other `vayu/http` includes, then replace lines 305-307:

```cpp
        std::string pre_request_script = json.value ("preRequestScript", std::string{});
        std::string post_request_script =
        json.value ("postRequestScript", std::string{});
```

with:

```cpp
        std::string pre_request_script =
        vayu::http::read_script (json, "preRequestScripts", "preRequestScript");
        std::string post_request_script =
        vayu::http::read_script (json, "postRequestScripts", "postRequestScript");
```

Add `script_parts.cpp` to the engine source list and `script_compose_test.cpp` to the test list.

- [ ] **Step 4: Build and run**

Run: `python build.py -t`
Run: `cd engine && ctest --preset windows-dev --output-on-failure -R ScriptParts`
Expected: 6 tests pass.

- [ ] **Step 5: Confirm one shared scope, end to end**

Start an engine on a spare port and send a two-part script where the second part reads a `const` from the first:

```bash
curl -s -X POST http://127.0.0.1:9890/request -H "Content-Type: application/json" -d '{
  "method":"GET","url":"http://127.0.0.1:9890/health",
  "preRequestScripts":[
    {"origin":"collection","script":"const shared = 42;"},
    {"origin":"request","script":"console.log(\"got \" + shared);"}
  ]}' | python -c "import json,sys; print(json.load(sys.stdin).get('consoleLogs'))"
```

Expected: `['got 42']`. If it errors with `shared is not defined`, the parts are being run separately, which is the failure this task must not introduce.

- [ ] **Step 6: Docs and commit**

Document both forms under `POST /request` in `docs/engine/api-reference.md`, and describe the list, the join and the single shared scope in `docs/engine/scripting.md`.

```bash
git add engine docs/engine
git commit -m "feat(engine): accept script parts as a list on POST /request

The clients joined the collection chain's scripts with the request's own and
sent one string, so a stored run could not say which part came from where.
The engine now takes the parts and joins them itself, with the same
separator and a single execute call - so all parts still share one scope and
error line numbers are unchanged. The old string form still works and the
list wins when both are sent."
```

---

### Task 6: `POST /run` takes script parts, and load runs finally see the collection's tests

**Files:**

- Modify: `engine/src/core/run_manager.cpp:192-193`
- Modify: `engine/tests/run_manager_test.cpp`
- Modify: `docs/engine/api-reference.md`, `docs/engine/scripting.md`

**Interfaces:**

- Consumes: `vayu::http::read_script` from Task 5.
- Produces: `POST /run` accepts `tests` as either a string or a list of parts.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/run_manager_test.cpp`:

```cpp
// A load run's `tests` may arrive as a list of parts, exactly like the design
// path's scripts. Before this, only the request's own test script was sent, so
// a collection-level assertion passed in design mode and was silently never
// checked under load.
TEST (RunManager, TestsAcceptAListOfParts) {
    auto config = nlohmann::json::parse (R"({
      "tests": [
        {"origin":"collection","id":"c1","name":"API","script":"pm.test(\"a\",()=>{});"},
        {"origin":"request","id":"r1","script":"pm.test(\"b\",()=>{});"}
      ]
    })");

    EXPECT_EQ (vayu::http::read_script (config, "tests", "tests"),
    "pm.test(\"a\",()=>{});\n\npm.test(\"b\",()=>{});");
}

TEST (RunManager, TestsStillAcceptAPlainString) {
    auto config = nlohmann::json::parse (R"({"tests":"pm.test(\"a\",()=>{});"})");

    EXPECT_EQ (vayu::http::read_script (config, "tests", "tests"), "pm.test(\"a\",()=>{});");
}
```

- [ ] **Step 2: Build and confirm it fails**

Run: `python build.py -t`
Expected: FAIL or a compile error for the missing include.

- [ ] **Step 3: Implement**

In `engine/src/core/run_manager.cpp`, add `#include "vayu/http/script_parts.hpp"` and replace:

```cpp
    if (config.contains ("tests")) {
        test_script = config["tests"].get<std::string> ();
```

with:

```cpp
    if (config.contains ("tests")) {
        // Either a plain string or a list of parts. `read_script` handles both
        // and picks the list when both are present. Load runs now receive the
        // collection chain's test scripts as well as the request's own; before
        // this, a collection-level assertion was silently never checked.
        test_script = vayu::http::read_script (config, "tests", "tests");
```

Check the surrounding lines still compile - the original `get<std::string>()` may sit inside a `try` or a type check that now needs adjusting, since `tests` may be an array.

- [ ] **Step 4: Build and run**

Run: `python build.py -t`
Run: `cd engine && ctest --preset windows-dev --output-on-failure -R RunManager`
Expected: PASS.

- [ ] **Step 5: Docs and commit**

Note in `docs/engine/api-reference.md` under `POST /run` that `tests` accepts both forms, and in `docs/engine/scripting.md` that load runs check the collection chain's test scripts.

```bash
git add engine docs/engine
git commit -m "feat(engine): POST /run takes test script parts, and runs the chain's

Load runs only ever validated the request's own test script, so a
collection-level assertion passed in design mode and was silently never
checked under load. \`tests\` now accepts the same list of parts the design
path uses, and the engine joins them.

This changes results: assertions that were never checked start being
checked, so testValidation counts move and some runs will report failures
they did not before."
```

---

# Phase 2: the clients stop gluing scripts

Renderer and MCP must change in the same commit. They are a known duplicate that has to stay in step.

---

### Task 7: Both clients send script parts

**Files:**

- Modify: `app/electron/mcp/resolve.ts:236-262` and its `OutgoingRequest` type at line 93
- Modify: `app/electron/mcp/resolve.test.ts` (the `describe("script composition")` block)
- Modify: `app/src/modules/request-builder/index.tsx:261-273` and the load payload at line 561
- Modify: `app/src/types/domain.ts` (`StartLoadTestRequest`) and the execute payload type
- Modify: `CLAUDE.md`, `docs/engine/mcp.md`, `docs/engine/architecture.md`, `docs/plans/pending-backlog.md`

**Interfaces:**

- Produces: `ScriptPart { origin: "collection" | "request"; id?: string; name?: string; script: string }` exported from `app/src/types/domain.ts`. `composeScripts` in `resolve.ts` returns `{ preRequestScripts?: ScriptPart[]; postRequestScripts?: ScriptPart[] }`.

- [ ] **Step 1: Add the shared type**

In `app/src/types/domain.ts`, add near the request types:

```ts
/**
 * One part of a script that runs for a request, and where it came from.
 *
 * The clients used to join the collection chain's scripts with the request's
 * own and send a single string, so a stored run could not say which part came
 * from where - and writing that string back to a request would put the
 * collection's script inside it permanently. The engine joins them now.
 */
export interface ScriptPart {
  origin: "collection" | "request";
  id?: string;
  /** Collection name, for showing the user where a part came from. */
  name?: string;
  script: string;
}
```

- [ ] **Step 2: Update the MCP test first**

In `app/electron/mcp/resolve.test.ts`, replace the `describe("script composition", ...)` block with:

```ts
describe("script parts", () => {
  test("chain parts (root to leaf) precede the request's own, each naming its source", () => {
    const chain = [
      {
        id: "c1",
        name: "root",
        preRequestScript: "A",
        postRequestScript: "PA",
      },
      {
        id: "c2",
        name: "leaf",
        preRequestScript: "B",
        postRequestScript: "PB",
      },
    ];
    const request = {
      id: "r1",
      preRequestScript: "C",
      postRequestScript: "PC",
    };

    const out = composeScripts(request as never, chain as never);

    expect(out.preRequestScripts).toEqual([
      { origin: "collection", id: "c1", name: "root", script: "A" },
      { origin: "collection", id: "c2", name: "leaf", script: "B" },
      { origin: "request", id: "r1", script: "C" },
    ]);
    expect(out.postRequestScripts?.map((p) => p.script)).toEqual([
      "PA",
      "PB",
      "PC",
    ]);
  });

  test("no scripts anywhere yields undefined, not an empty list", () => {
    const out = composeScripts({ id: "r1" } as never, []);

    expect(out.preRequestScripts).toBeUndefined();
    expect(out.postRequestScripts).toBeUndefined();
  });

  test("parts that are empty or only whitespace are dropped", () => {
    const out = composeScripts(
      { id: "r1", preRequestScript: "real" } as never,
      [{ id: "c1", name: "root", preRequestScript: "   " }] as never,
    );

    expect(out.preRequestScripts).toEqual([
      { origin: "request", id: "r1", script: "real" },
    ]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd app && pnpm vitest run electron/mcp/resolve.test.ts`
Expected: FAIL, `preRequestScripts` is undefined because `composeScripts` still returns strings.

- [ ] **Step 4: Rewrite MCP's composition**

In `app/electron/mcp/resolve.ts`, replace `joinScripts` and `composeScripts` with:

```ts
/**
 * Collect the script parts that run for a request: the collection chain's,
 * root to leaf, then the request's own. Each part records where it came from.
 *
 * The engine joins them and runs the result as one script. It used to be joined
 * here, which meant a stored run could not say which part came from where.
 */
function scriptParts(
  chain: CollectionLike[],
  pick: (c: CollectionLike) => string | undefined,
  requestId: string | undefined,
  requestScript: string | undefined,
): ScriptPart[] | undefined {
  const parts: ScriptPart[] = [];
  for (const c of chain) {
    const script = pick(c);
    if (script && script.trim()) {
      parts.push({ origin: "collection", id: c.id, name: c.name, script });
    }
  }
  if (requestScript && requestScript.trim()) {
    parts.push({ origin: "request", id: requestId, script: requestScript });
  }
  return parts.length > 0 ? parts : undefined;
}

export function composeScripts(
  request: SavedRequestLike,
  chain: CollectionLike[],
): { preRequestScripts?: ScriptPart[]; postRequestScripts?: ScriptPart[] } {
  return {
    preRequestScripts: scriptParts(
      chain,
      (c) => c.preRequestScript,
      request.id,
      request.preRequestScript,
    ),
    postRequestScripts: scriptParts(
      chain,
      (c) => c.postRequestScript,
      request.id,
      request.postRequestScript,
    ),
  };
}
```

Update `OutgoingRequest` (line 93). Replace the two script string fields with the lists, and fix the comment, which claims `/run` accepts this body although `/run` reads neither script field:

```ts
/** The body the engine's `POST /request` accepts. `POST /run` takes its own shape. */
export interface OutgoingRequest {
  // ... unchanged fields ...
  preRequestScripts?: ScriptPart[];
  postRequestScripts?: ScriptPart[];
  // ... unchanged fields ...
}
```

Update the assignment near line 364:

```ts
if (scripts.preRequestScripts)
  out.preRequestScripts = scripts.preRequestScripts;
if (scripts.postRequestScripts)
  out.postRequestScripts = scripts.postRequestScripts;
```

Make sure `CollectionLike` has `id` and `name`. Add them if missing.

- [ ] **Step 5: Run the MCP tests**

Run: `cd app && pnpm vitest run electron/mcp/resolve.test.ts`
Expected: PASS.

- [ ] **Step 6: Change the renderer in the same commit**

In `app/src/modules/request-builder/index.tsx`, replace the composition block at lines 261-273:

```ts
					// Compose pre/post scripts: collection chain root→leaf, then the request's own script
					const composedPreScript = [ ... ].filter(Boolean).join("\n\n");
					const composedPostScript = [ ... ].filter(Boolean).join("\n\n");
```

with:

```ts
// Script parts: the collection chain root to leaf, then the
// request's own. The engine joins them and runs the result as
// one script. Joining here meant a stored run could not say
// which part came from where.
const preScriptParts = scriptParts(
  collectionAncestors,
  (c) => c.preRequestScript,
  fetchedRequest.id,
  request.preRequestScript,
);
const postScriptParts = scriptParts(
  collectionAncestors,
  (c) => c.postRequestScript,
  fetchedRequest.id,
  request.testScript,
);
```

Change the two payload lines:

```ts
							preRequestScript: composedPreScript || undefined,
							postRequestScript: composedPostScript || undefined,
```

to:

```ts
							preRequestScripts: preScriptParts,
							postRequestScripts: postScriptParts,
```

Change the variable-refresh guard just below, which reads the old name:

```ts
					if (preScriptParts) {
```

Create `app/src/modules/request-builder/utils/script-parts.ts` holding the renderer's own `scriptParts` helper.

**It cannot be shared with MCP.** `app/tsconfig.node.json` includes only `electron`, so `resolve.ts` cannot import from `app/src/`. The helper is therefore written twice, which is the same intentional duplication `CLAUDE.md` already describes for the rest of composition. Keep the two byte-identical in behaviour and let `resolve.test.ts` guard the parity, exactly as it does today. Do not try to reach across the boundary.

In the load payload at line 561, replace:

```ts
					tests: pendingLoadTestRequest.testScript || undefined,
```

with:

```ts
					// The collection chain's test scripts too. Load runs only ever
					// validated the request's own, so a collection-level assertion
					// passed in design mode and was never checked under load.
					tests: scriptParts(
						collectionAncestors,
						(c) => c.postRequestScript,
						fetchedRequest.id,
						pendingLoadTestRequest.testScript
					),
```

Update `StartLoadTestRequest.tests` in `app/src/types/domain.ts` to `ScriptPart[] | undefined`, and the execute payload type's two script fields to `ScriptPart[] | undefined`.

- [ ] **Step 7: Full suite and types**

Run: `cd app && pnpm type-check`
Run: `cd app && pnpm test`
Expected: both clean. Fix any test that asserted on the old string fields.

- [ ] **Step 8: Update the docs that now say something false**

- `CLAUDE.md`, section _Request composition (known duplication)_: it says composing scripts happens client-side in both copies. Scripts now happen engine-side. Variables and inherit auth still do not. Rewrite that paragraph precisely, keeping the rule that the two clients must change together for what remains.
- `docs/engine/mcp.md`, _Request composition_: same correction.
- `docs/engine/architecture.md`, _Request composition boundary_: same.
- `docs/plans/pending-backlog.md`, item A1: record that the script part is done and the rest is open.

- [ ] **Step 9: Commit both clients together**

```bash
git add app/src app/electron CLAUDE.md docs
git commit -m "refactor(app): send script parts instead of one glued string

The renderer and MCP each joined the collection chain's scripts with the
request's own and sent the result. A stored run therefore could not say
which part came from where, and writing that string back to a request would
have put the collection's script inside it permanently.

Both clients now send the parts and the engine joins them. This is the
script slice of backlog item A1 and only that slice; variable substitution
and inherited auth still happen client-side, so the two copies still have
to change together.

Load runs now also send the collection chain's test scripts, which they
never did."
```

---

# Phase 3: the feature

---

### Task 8: Build the starting values from a run

A pure function, tested on its own, so the component in Task 9 has nothing to prove but rendering.

**Files:**

- Create: `app/src/modules/history/main/design-run-seed.ts`
- Create: `app/src/modules/history/main/design-run-seed.test.ts`

**Interfaces:**

- Consumes: `Run`, `ScriptPart` from `@/types`; `RequestState` from `@/modules/request-builder/types`.
- Produces: `seedFromRun(run: Run, liveRequest?: Request | null): { request: Partial<RequestState>; collectionScripts: ScriptPart[]; legacyScript?: string }`.

- [ ] **Step 1: Write the failing test**

Create `app/src/modules/history/main/design-run-seed.test.ts`:

```ts
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Starting values for a design run opened as a detached copy.
 *
 * Three sources, each for what only it has. `configSnapshot` is the payload
 * that was sent. `result.trace` is what went out after auth was applied. The
 * live request is the only place credentials exist, because
 * `sanitize_config_snapshot` strips them before saving.
 */

import { describe, it, expect } from "vitest";
import { seedFromRun } from "./design-run-seed";
import type { Run, Request } from "@/types";

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    type: "design",
    status: "completed",
    startTime: 1_750_000_000_000,
    endTime: 1_750_000_000_300,
    requestId: "req_1",
    environmentId: null,
    configSnapshot: {
      method: "POST",
      url: "https://api.example.test/users?page=2",
      headers: { "X-Plain": "visible" },
      body: { mode: "json", content: '{"a":1}' },
      auth: { mode: "bearer" },
      preRequestScripts: [
        {
          origin: "collection",
          id: "col_1",
          name: "API",
          script: "const t = 1;",
        },
        { origin: "request", id: "req_1", script: "console.log(t);" },
      ],
      followRedirects: false,
      maxRedirects: 3,
      requestId: "req_1",
    },
    result: {
      timestamp: 1_750_000_000_000,
      statusCode: 200,
      statusText: "OK",
      latencyMs: 12,
      trace: {
        request: {
          method: "POST",
          url: "https://api.example.test/users?page=2",
          headers: { "X-Plain": "visible", Authorization: "Bearer SECRET" },
          body: '{"a":1}',
        },
        response: { headers: {}, body: "{}" },
      },
    },
    ...overrides,
  } as Run;
}

const liveRequest = {
  id: "req_1",
  collectionId: "col_1",
  auth: { mode: "bearer", token: "FRESH-TOKEN" },
} as unknown as Request;

describe("seedFromRun", () => {
  it("takes method, url and the structured body from the snapshot", () => {
    const { request } = seedFromRun(run(), liveRequest);

    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.example.test/users?page=2");
    expect(request.bodyMode).toBe("json");
    expect(request.body).toBe('{"a":1}');
  });

  it("parses params out of the url", () => {
    const { request } = seedFromRun(run(), liveRequest);

    expect(
      request.params?.some((p) => p.key === "page" && p.value === "2"),
    ).toBe(true);
  });

  it("has no id, which is what stops anything being saved", () => {
    // useSaveManager stops early on a null entityId, and the response store
    // is keyed by id so nothing is written to it either.
    const { request } = seedFromRun(run(), liveRequest);

    expect(request.id).toBeNull();
    expect(request.collectionId).toBeNull();
  });

  it("keeps the redirect settings the run used", () => {
    const { request } = seedFromRun(run(), liveRequest);

    expect(request.followRedirects).toBe(false);
    expect(request.maxRedirects).toBe(3);
  });

  describe("when the request still exists", () => {
    it("takes headers from the snapshot, so no credential is in them", () => {
      const { request } = seedFromRun(run(), liveRequest);

      const keys = request.headers?.map((h) => h.key) ?? [];
      expect(keys).toContain("X-Plain");
      expect(keys).not.toContain("Authorization");
    });

    it("takes auth from the live request, the only place it exists", () => {
      const { request } = seedFromRun(run(), liveRequest);

      expect(request.authType).toBe("bearer");
      expect(request.authConfig?.token).toBe("FRESH-TOKEN");
    });
  });

  describe("when the request is gone", () => {
    it("takes headers from the trace, including the Authorization that went out", () => {
      const { request } = seedFromRun(run(), null);

      const auth = request.headers?.find((h) => h.key === "Authorization");
      expect(auth?.value).toBe("Bearer SECRET");
    });

    it("sets authType to none, because auth is already inside those headers", () => {
      const { request } = seedFromRun(run(), null);

      expect(request.authType).toBe("none");
    });
  });

  describe("scripts", () => {
    it("gives the script tab only the request's own part", () => {
      const { request } = seedFromRun(run(), liveRequest);

      expect(request.preRequestScript).toBe("console.log(t);");
    });

    it("returns the collection parts separately, to show read-only", () => {
      const { collectionScripts } = seedFromRun(run(), liveRequest);

      expect(collectionScripts).toEqual([
        {
          origin: "collection",
          id: "col_1",
          name: "API",
          script: "const t = 1;",
        },
      ]);
    });

    it("returns a run stored before script parts as a legacy string", () => {
      // Nothing marks the boundaries in the old glued string, so it cannot
      // be split. Show it whole, and let Save leave scripts alone.
      const legacy = run({
        configSnapshot: {
          method: "GET",
          url: "https://x.test/",
          preRequestScript: "collectionPart\n\nrequestPart",
        },
      } as Partial<Run>);

      const seed = seedFromRun(legacy, liveRequest);

      expect(seed.legacyPreScript).toBe("collectionPart\n\nrequestPart");
      expect(seed.collectionScripts).toEqual([]);
      expect(seed.request.preRequestScript).toBe("");
    });
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd app && pnpm vitest run src/modules/history/main/design-run-seed.test.ts`
Expected: FAIL, cannot find `./design-run-seed`.

- [ ] **Step 3: Implement**

Create `app/src/modules/history/main/design-run-seed.ts`:

```ts
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turn a stored design run into starting values for the request builder.
 *
 * Pure on purpose: no hooks, no queries, no store. The view that renders it
 * then has nothing to prove but rendering.
 *
 * Three sources, each for what only it has:
 *
 *   configSnapshot    the payload that was sent
 *   result.trace      what went out, after the engine applied auth
 *   the live request  credentials, which are never stored - the engine's
 *                     sanitize_config_snapshot keeps only the auth mode
 */

import type { Run, Request, ScriptPart, KeyValueEntry } from "@/types";
import type { RequestState } from "@/modules/request-builder/types";
import { authToEditor } from "@/modules/request-builder/utils/auth-mapping";
import { toKeyValueItems } from "@/modules/request-builder/utils/key-value";
import { parseQueryParams } from "@/modules/request-builder/utils/url";
import { createDefaultRequestState } from "@/modules/request-builder/utils/request-state";

/** The part of a design run's snapshot this reads. */
interface DesignSnapshot {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: { mode?: string; content?: string; fields?: KeyValueEntry[] };
  auth?: { mode?: string };
  preRequestScripts?: ScriptPart[];
  postRequestScripts?: ScriptPart[];
  preRequestScript?: string;
  postRequestScript?: string;
  followRedirects?: boolean;
  maxRedirects?: number;
}

export interface DesignRunSeed {
  /** Starting values. `id` is null, and that is what detaches the copy. */
  request: Partial<RequestState>;
  /** Collection parts, to show read-only next to the request's own. */
  collectionScripts: ScriptPart[];
  /** Set only for a run stored before script parts existed. */
  legacyPreScript?: string;
  legacyPostScript?: string;
}

function toHeaderItems(headers: Record<string, string> | undefined) {
  return toKeyValueItems(
    Object.entries(headers ?? {}).map(([key, value]) => ({
      key,
      value,
      enabled: true,
    })),
  );
}

/** The request's own part, or "" when the run predates script parts. */
function ownScript(parts: ScriptPart[] | undefined): string {
  return parts?.find((p) => p.origin === "request")?.script ?? "";
}

export function seedFromRun(
  run: Run,
  liveRequest?: Request | null,
): DesignRunSeed {
  const snapshot = (run.configSnapshot ?? {}) as DesignSnapshot;
  const trace = run.result?.trace;

  /*
   * Headers and auth move together. With a live request we show its current
   * auth, because that is what a fresh resolution will send, and the snapshot
   * headers hold no credential. Without one there is nothing to resolve, so
   * the wire headers are used as they are - the recorded Authorization
   * included - and the copy replays exactly what ran.
   */
  const headers = liveRequest
    ? toHeaderItems(snapshot.headers)
    : toHeaderItems(trace?.request?.headers);
  const auth = liveRequest
    ? authToEditor(liveRequest.auth)
    : { authType: "none" as const, authConfig: {} };

  const body = snapshot.body;
  const bodyMode = (body?.mode ?? "none") as RequestState["bodyMode"];

  return {
    request: {
      ...createDefaultRequestState(),
      id: null,
      collectionId: null,
      method: (snapshot.method ?? "GET") as RequestState["method"],
      url: snapshot.url ?? "",
      params: parseQueryParams(snapshot.url ?? ""),
      headers,
      bodyMode,
      body: body?.content ?? "",
      formData: toKeyValueItems(
        bodyMode === "form-data" ? (body?.fields ?? []) : [],
      ),
      urlEncoded: toKeyValueItems(
        bodyMode === "x-www-form-urlencoded" ? (body?.fields ?? []) : [],
      ),
      authType: auth.authType,
      authConfig: auth.authConfig,
      preRequestScript: ownScript(snapshot.preRequestScripts),
      testScript: ownScript(snapshot.postRequestScripts),
      followRedirects: snapshot.followRedirects ?? true,
      maxRedirects: snapshot.maxRedirects ?? 5,
    },
    collectionScripts: [
      ...(snapshot.preRequestScripts ?? []),
      ...(snapshot.postRequestScripts ?? []),
    ].filter((p) => p.origin === "collection"),
    legacyPreScript: snapshot.preRequestScripts
      ? undefined
      : snapshot.preRequestScript,
    legacyPostScript: snapshot.postRequestScripts
      ? undefined
      : snapshot.postRequestScript,
  };
}
```

Add `result?: RunResult` to the `Run` interface in `app/src/types/domain.ts`. The trace shape is already declared inline under `RunReport["results"]`; pull it out into a named `RunResultTrace` interface and use it in both places rather than writing it twice.

- [ ] **Step 4: Run the tests**

Run: `cd app && pnpm vitest run src/modules/history/main/design-run-seed.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Mutation-check the detaching**

Change `id: null` to `id: run.requestId ?? null` and rerun. The "no id" test must fail. Restore it. That one line is the whole detachment, so it is worth knowing a test holds it.

- [ ] **Step 6: Types, format, commit**

```bash
cd app && pnpm type-check
cd app && pnpm exec prettier --write src/modules/history/main/design-run-seed.ts src/modules/history/main/design-run-seed.test.ts src/types/domain.ts
cd .. && git add app/src
git commit -m "feat(app): build request-builder starting values from a stored run"
```

---

### Task 9: The detached builder

**Files:**

- Create: `app/src/modules/history/main/DesignRunView.tsx`
- Create: `app/src/modules/history/main/DesignRunView.test.tsx`
- Modify: `app/src/modules/request-builder/context/RequestBuilderProvider.tsx` (add `initialResponse`)

**Interfaces:**

- Consumes: `seedFromRun` from Task 8.
- Produces: `DesignRunView({ run }: { run: Run })`.

- [ ] **Step 1: Add `initialResponse` to the provider**

The provider seeds its response from the store by id. A detached copy has no id, so it needs the response handed to it:

```ts
interface RequestBuilderProviderProps {
  children: ReactNode;
  initialRequest?: Partial<RequestState>;
  /**
   * Starting response for a builder with no id, which cannot read the store.
   * Used by the History run view, where the response comes from the run.
   */
  initialResponse?: ResponseState | null;
  collectionId?: string | null;
  onExecute?: (request: RequestState) => Promise<ResponseState | null>;
  onSave?: (request: RequestState) => Promise<void>;
  onStartLoadTest?: (request: RequestState) => void;
}
```

In the `useState` initialiser for `response`, return `initialResponse ?? null` when there is no stored value.

- [ ] **Step 2: Write the failing test**

Create `app/src/modules/history/main/DesignRunView.test.tsx` with `@vitest-environment jsdom`, asserting:

- the builder's response tabs render (Body, Headers, Cookies, Timing, Raw)
- the age chip is present
- the Raw tab shows the body that was sent
- a run that failed shows "Could not get a response" and its hint
- typing in the URL bar triggers no save mutation
- the send button is present and enabled

- [ ] **Step 3: Run and confirm it fails**

Run: `cd app && pnpm vitest run src/modules/history/main/DesignRunView.test.tsx`

- [ ] **Step 4: Implement**

`DesignRunView` renders `RequestBuilderProvider` with the seed, `initialResponse`, an `onExecute` that sends the editor contents, and **no `onSave`**. Inside it renders `RequestBuilderLayout`. Add a file-level comment saying the missing `onSave` is what makes the copy detached, so nobody adds one back.

**`onExecute` sends the editor contents plus the recorded collection parts.** Build the payload as `preRequestScripts: [...seed.collectionScripts, { origin: "request", script: <editor value> }]`, so a resend runs the collection scripts **as they were recorded**, not as the collection reads now. Include `requestId: run.requestId` so the new run is filed under the same request. Resolve auth from the live request when it exists; when it does not, the seed already put the recorded `Authorization` in the headers, so send them as they are.

**Show the collection parts.** `seed.collectionScripts` has to render somewhere read-only, or the copy silently hides script text that will run. Task 13 builds `InheritedScriptsNotice` for the normal builder; this view needs the same component. If you are executing tasks in order, render nothing here yet and add it in Task 13. If you are executing Task 9 alone, build the component here and let Task 13 reuse it. Either way one component, two callers.

- [ ] **Step 5: Mutation-check detachment**

Add an `onSave` that calls a spy, rerun, and confirm the "no save" test fails. Remove it.

- [ ] **Step 6: Run, type-check, commit**

```bash
git add app/src/modules/history/main app/src/modules/request-builder/context
git commit -m "feat(app): open a design run as a detached copy of what was sent"
```

---

### Task 10: Route run tabs to it, and delete the old viewer

**Nothing to do in `HistoryList` or `RecentRuns`.** Both already open
`{ type: "run", entityId: runId }`, which is what this design wants. The abandoned branch
introduced a `useOpenRun` hook that opened a request tab instead; it does not exist on this
branch and must not be recreated. If you find yourself writing one, re-read the spec's
"Which tab opens".

**Files:**

- Modify: `app/src/modules/history/main/HistoryDetail.tsx`
- Delete: `app/src/modules/history/main/DesignRunDetail.tsx`
- Modify: `app/src/modules/history/main/index.ts`, `app/src/modules/history/index.ts`, `app/src/modules/history/types.ts`
- Modify: `app/src/modules/history/main/HistoryDetail.states.test.tsx`
- Modify: `app/src/modules/README.md`, `docs/app/COMPONENTS.md`

- [ ] **Step 1: Fetch the run itself**

`HistoryDetail` currently fetches only the report. Add a `useRunQuery(runId)` in `app/src/queries/runs.ts` wrapping the already-existing, never-used `apiService.getRun`:

```ts
/**
 * Fetch one run, including its configSnapshot and - for a design run - the
 * stored exchange. The report is a load-test aggregate and carries no
 * configuration for a design run, so this is the only source for it.
 */
export function useRunQuery(runId: string | null) {
  return useQuery({
    queryKey: queryKeys.runs.detail(runId ?? ""),
    queryFn: () => apiService.getRun(runId!),
    enabled: !!runId,
    staleTime: QUERY_CACHE.RUNS_STALE_TIME_MS,
  });
}
```

Export it from `app/src/queries/index.ts`.

- [ ] **Step 2: Route by type**

In `HistoryDetail`, use `useRunQuery` for the run and keep `useRunReportQuery` for load runs only. Render `DesignRunView` for a design run and `LoadTestDetail` for a load run. Shrink the header so the run's URL is not shown twice - the builder below has the URL bar.

- [ ] **Step 3: Delete the old viewer and its references**

```bash
git rm app/src/modules/history/main/DesignRunDetail.tsx
```

Remove `DesignRunDetail` from both barrel files, remove `DesignRunDetailProps` from `types.ts`, and change the `vi.mock("./DesignRunDetail", ...)` in `HistoryDetail.states.test.tsx` to mock `./DesignRunView`.

- [ ] **Step 4: Run the suite, type-check, update docs, commit**

Update `app/src/modules/README.md` and the History section of `docs/app/COMPONENTS.md` to describe the run tab as a detached copy.

```bash
git add -A app/src docs app/src/modules/README.md
git commit -m "refactor(app): run tabs render the detached copy, DesignRunDetail is gone

That viewer was a second response pane for the same stored row - a
\`trace as any\`, its own status chip, its own timing renderer - and it
showed the body that was sent nowhere at all: it built it from the trace
and then rendered a mode that reads only headers."
```

---

### Task 11: Save to request

**Files:**

- Create: `app/src/modules/history/main/SaveRunToRequestDialog.tsx`
- Create: `app/src/modules/history/main/save-run-to-request.ts` (the diff, pure)
- Create: `app/src/modules/history/main/save-run-to-request.test.ts`
- Modify: `app/src/modules/history/main/DesignRunView.tsx`

**Interfaces:**

- Produces: `diffRunAgainstRequest(seed, liveRequest): Array<{ field: string; from: string; to: string }>` and `applyRunToRequest(seed, liveRequest): UpdateRequestRequest`.

- [ ] **Step 1: Write the failing test**

Cover, with one `it` each:

- writes method, url, params, headers, body, redirect settings
- writes the request's own script part
- **never writes auth**, even when the run recorded a mode
- **omits scripts entirely for a run with only the old glued string**
- the diff lists only fields that actually changed
- the diff names the omitted fields as unchanged, so the exclusion is visible

- [ ] **Step 2: Run, confirm failure, implement, run again**

Follow the spec's "Save to request" section exactly.

- [ ] **Step 3: Wire the dialog**

The button is hidden when `run.requestId` does not resolve. The dialog shows the diff, the run's age, and a line saying edits made since will be lost. Use the existing `DeleteConfirmDialog` as the structural pattern; do not invent a new dialog primitive.

- [ ] **Step 4: Full suite, type-check, format, commit**

```bash
git add app/src/modules/history/main
git commit -m "feat(app): save a run's values back to its request, behind a confirm"
```

---

# Phase 4: what the feature makes possible

---

### Task 12: Shrink `UnifiedResponseViewer` to the embedded sample view

Its full mode had two callers. One is deleted, the other passes `compact`. Nothing reaches the full branch.

**Files:**

- Modify: `app/src/components/shared/response-viewer/UnifiedResponseViewer.tsx`
- Modify: `app/src/components/shared/response-viewer/types.ts`, `index.ts`
- Modify: `app/src/modules/history/main/components/SampleRequestCard.tsx`

- [ ] **Step 1: Delete the full-mode branch**

Keep the compact layout as the only render path. Remove the `compact`, `showActions`, `trace` and `hiddenTabs` props, and the `TraceData` type. Note in the file comment what it is now and why the full mode went.

`SampleRequestCard` passes `hiddenTabs={["request"]}`, which names a tab the compact view never had - it matched nothing. Remove it along with `compact` and `showActions`.

- [ ] **Step 2: Run the suite, type-check, commit**

```bash
git add app/src/components/shared/response-viewer app/src/modules/history/main/components
git commit -m "refactor(app): UnifiedResponseViewer is only the embedded sample view now"
```

---

### Task 13: Show which collection scripts will run

The builder tells you when auth is inherited (`AuthInheritBanner`) and tells you nothing about inherited scripts, so you cannot see what runs before your own.

**Files:**

- Create: `app/src/modules/request-builder/components/RequestTabs/panels/InheritedScriptsNotice.tsx`
- Create: its test
- Modify: `PreScriptPanel.tsx`, `TestScriptPanel.tsx`

- [ ] **Step 1: Write the failing test**

It renders one entry per collection in the chain that has a script, names the collection, and renders nothing when the chain has none.

- [ ] **Step 2: Implement, following `AuthInheritBanner`'s shape**

Read the chain with `useCollectionAncestors`, which `AuthInheritBanner` already uses. Read-only. No editing.

- [ ] **Step 3: Run, type-check, commit**

```bash
git add app/src/modules/request-builder/components/RequestTabs/panels
git commit -m "feat(app): show which collection scripts run before your own"
```

---

### Task 14: Test `Shell`'s sidebar effect

It has no test today. That absence is why an earlier version of this feature shipped a bug where opening a design run threw the user out of the History list.

**Files:**

- Create: `app/src/components/layout/drawer-auto-view.test.tsx`

- [ ] **Step 1: Write the test**

With `@vitest-environment jsdom`, mock the heavy children (`Drawer`, `Dock`, `ContextBar`, and every screen), set the sidebar view and the active tab, render `Shell`, and read `useLayoutStore.getState().drawerView`.

Assert: a `variables` tab claims the variables view; a `settings` tab claims settings; a `request` tab claims collections; **a `run` tab leaves the sidebar alone**. That last one is the regression guard.

- [ ] **Step 2: Mutation-check**

Add `run` to the branch that switches to collections, confirm the test fails, and remove it.

- [ ] **Step 3: Run, commit**

```bash
git add app/src/components/layout
git commit -m "test(app): pin which sidebar view each tab type claims"
```

---

## Finishing

- [ ] `cd app && pnpm type-check`
- [ ] `cd app && pnpm test`
- [ ] `python build.py -t && cd engine && ctest --preset windows-dev --output-on-failure`
- [ ] `cd app && pnpm exec prettier --check` on every file you touched that was already clean
- [ ] Write `.github/release-notes/vX.Y.Z.md` noting that **load-test results will change**: collection-level assertions that were never checked are now checked, so `testValidation` counts move and some runs will report failures they did not before.
- [ ] Open the PR against master.
