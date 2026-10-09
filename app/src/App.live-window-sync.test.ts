/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The App root syncs the engine's live-chart retention into the dashboard
 * store (#1936).
 *
 * `useLiveWindowSync` is the only path from the engine's `liveReplayWindowMs` /
 * `liveMaxRetainedTicks` config to the store, and a run streams into the store
 * whichever tab is open. Mounted under Settings > Dashboard instead, it ran only
 * while that page was on screen. The hook's behaviour is pinned in
 * `hooks/useLiveChartSettings.test.tsx`; this case pins the *call site*, which
 * that one cannot see.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP_SOURCE = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");

describe("the App root's live-window wiring", () => {
	it("reads a non-empty App.tsx", () => {
		// A guard that scanned an empty string would pass forever.
		expect(APP_SOURCE.length).toBeGreaterThan(0);
		expect(APP_SOURCE).toContain("function App()");
	});

	it("mounts the live-window sync", () => {
		expect(APP_SOURCE).toMatch(/\buseLiveWindowSync\s*\(\s*\)/);
	});
});
