/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every failure the dashboard can record has to reach the screen.
 *
 * Three did not. The report fetch retried forever behind a `console.error`;
 * stopping a run failed silently; and the SSE layer wrote its error into
 * `useDashboardStore.error`, which no component read — so a dead metrics stream
 * looked exactly like a run that produced no data.
 *
 * The last one is what this guards. It is a wiring bug, not a logic bug: the
 * state existed, the writer existed, and the reader was simply missing. A unit
 * test of the store cannot catch that, so this checks the component actually
 * consumes it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = readFileSync(join(here, "index.tsx"), "utf8");
const store = readFileSync(join(here, "..", "..", "stores", "dashboard-store.ts"), "utf8");
const service = readFileSync(join(here, "..", "..", "services", "load-test-service.ts"), "utf8");

/** Strip comments — several of these files explain the bug in prose. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("dashboard error surfacing", () => {
	it("reads the files it is guarding", () => {
		expect(dashboard.length).toBeGreaterThan(1000);
		expect(store).toContain("setError");
		expect(service).toContain("setError");
	});

	it("still has a writer for the stream error", () => {
		// If this ever stops being written, the reader below is dead weight and
		// should go too rather than sit there looking like coverage.
		expect(code(service)).toMatch(/store\.setError\(error\.message\)/);
	});

	it("reads the stream error in the component", () => {
		expect(code(dashboard)).toMatch(/error:\s*streamError/);
		expect(code(dashboard)).toContain("streamError");
	});

	it("renders a notice for both failure kinds", () => {
		const body = code(dashboard);
		expect(body).toMatch(/streamError \|\| reportError/);
		expect(body).toContain("Lost the live metrics stream");
		expect(body).toContain("Couldn't load the run report");
	});

	it("offers a way out of each", () => {
		// Matched as JSX text nodes, not substrings. `toContain("Reconnect")`
		// passed against a mutation that renamed the button, because the file
		// also logs "Reconnecting to run …" — mutation testing caught it.
		const body = code(dashboard);
		expect(body).toMatch(/>\s*Reconnect\s*</);
		expect(body).toMatch(/>\s*Retry\s*</);
	});
});
