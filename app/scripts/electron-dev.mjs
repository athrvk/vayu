#!/usr/bin/env node
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * electron-dev wrapper
 *
 * Runs the dev stack (Vite + tsc-watch + Electron under concurrently) and
 * exits 0 when the user terminates with Ctrl+C, so pnpm doesn't print the
 * loud `ELIFECYCLE Command failed.` banner on a clean user-initiated stop.
 *
 * Any genuine non-SIGINT failure (compile error, port conflict, crash) is
 * still surfaced — we only swallow the 130 / null cases that come from
 * killing children with SIGINT.
 */

import { spawn } from "node:child_process";

const command = [
	"concurrently -k -r",
	'"pnpm:dev"',
	'"pnpm:electron:watch"',
	'"wait-on http://localhost:5173 && pnpm electron:compile && pnpm electron:start"',
].join(" ");

const child = spawn(command, {
	shell: true,
	stdio: "inherit",
});

let userInterrupted = false;
process.on("SIGINT", () => {
	userInterrupted = true;
	// Let the child handle its own SIGINT (it'll propagate to grandchildren).
	// Do NOT exit here — wait for the child's exit event so its cleanup
	// (engine sidecar graceful shutdown etc.) gets a chance to finish.
});
process.on("SIGTERM", () => {
	userInterrupted = true;
});

child.on("exit", (code, signal) => {
	if (userInterrupted || signal === "SIGINT" || signal === "SIGTERM" || code === 130) {
		process.exit(0);
	}
	process.exit(code ?? 1);
});
