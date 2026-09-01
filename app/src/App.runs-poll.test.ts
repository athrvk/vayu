/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The App root warms the runs list; it does not observe it (#1150).
 *
 * `useRunsQuery` carries a 5s `refetchInterval`, so *any* observer of it holds
 * a poll open for as long as it is mounted - and the root is mounted for the
 * app's whole visible life. Mounting it there cost a renderer fetch, three
 * engine queries and a main-process stdout wake every 5s with History closed,
 * nothing running and nobody reading the result.
 *
 * The behaviour is pinned in `queries/runs.query.test.tsx` (`usePrefetchRuns`
 * fetches once and installs no timer). This case pins the *call site*, which
 * that one cannot see: re-adding `useRunsQuery()` to `App.tsx` would restore
 * the lifetime poll while every hook-level test stayed green.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP_SOURCE = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");

describe("the App root's runs wiring", () => {
	it("reads a non-empty App.tsx", () => {
		// A guard that scanned an empty string would pass forever.
		expect(APP_SOURCE.length).toBeGreaterThan(0);
		expect(APP_SOURCE).toContain("function App()");
	});

	it("warms the runs list with the prefetch hook", () => {
		expect(APP_SOURCE).toContain("usePrefetchRuns()");
	});

	it("never mounts the polled runs query", () => {
		expect(APP_SOURCE).not.toMatch(/\buseRunsQuery\s*\(/);
	});
});
