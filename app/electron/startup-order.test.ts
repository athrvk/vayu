/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * First paint does not wait on the engine (issue #1144).
 *
 * The window used to be created only after the sidecar's `/health` handshake
 * resolved, which put the engine's entire startup - `db.init()`'s orphan
 * reconciliation, inbox cleanup and page-reclaim rewrite, all of it before the
 * engine listens at all - in front of a blank screen, for up to the 45-second
 * readiness budget. The renderer never needed it: it polls `/health` over HTTP
 * itself and renders the disconnected state until one answers.
 *
 * `main.ts` creates windows and starts the engine at import time, so the wiring
 * itself can only be read - the same characterization approach
 * `renderer-recovery.test.ts` and `quit-shutdown.test.ts` take to main.ts's own
 * sequencing. The behaviour underneath is driven for real in `sidecar.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

describe("startup ordering", () => {
	it("creates the window before it waits on the engine", () => {
		// One tab of indent is the `whenReady` handler's own call. The other,
		// deeper-indented one is the macOS activate handler rebuilding a closed
		// window, which runs long after startup and says nothing about ordering.
		const windowAt = main.indexOf("\n\tcreateWindow();");
		const engineAt = main.indexOf("\n\tawait startEngine();");

		expect(windowAt).toBeGreaterThan(-1);
		expect(engineAt).toBeGreaterThan(-1);
		expect(windowAt).toBeLessThan(engineAt);
	});

	it("still starts MCP after the window, which is why the ordering rule existed", () => {
		// MCP reads a config file, and a corrupt one once left the app with a
		// headless engine and no window at all. Overlapping the engine with the
		// window does not license overlapping this too.
		const windowAt = main.indexOf("\n\tcreateWindow();");
		// One tab again: `startMcp` is also called by the MCP enable/disable IPC
		// handler, which says nothing about startup ordering.
		const mcpAt = main.indexOf("\n\tawait startMcp();");

		expect(mcpAt).toBeGreaterThan(-1);
		expect(mcpAt).toBeGreaterThan(windowAt);
	});

	it("does not quit the app for an engine that is merely slow", () => {
		// The whole point of the split: `EngineNotReadyError` returns, everything
		// else still reaches the dialog and the quit below it.
		const notReadyAt = main.indexOf("error instanceof EngineNotReadyError");
		const quitAt = main.indexOf("app.quit();", notReadyAt);

		expect(notReadyAt).toBeGreaterThan(-1);
		expect(quitAt).toBeGreaterThan(notReadyAt);
		// The early return sits between the two, so a slow engine never reaches
		// the quit. Revert it and this window contains no `return`.
		expect(main.slice(notReadyAt, quitAt)).toContain("return;");
	});
});
