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
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const isWindows = process.platform === "win32";

// How long to wait for a graceful teardown on Windows before force-killing
// the tree. Generous enough for the engine sidecar to flush and exit.
const WINDOWS_KILL_GRACE_MS = 5000;

const args = [
	"-k",
	"-r",
	"pnpm:dev",
	"pnpm:electron:watch",
	"wait-on http://localhost:5173 && pnpm electron:compile && pnpm electron:start",
];

let child;

if (isWindows) {
	// Windows has no signal propagation: Ctrl+C is a console control event the
	// OS delivers to every process attached to the console. A `shell: true`
	// spawn here means cmd.exe, which responds to that event by printing
	// "Terminate batch job (Y/N)?" and blocking on stdin. With stdio inherited
	// that read races the parent shell's line editor for keystrokes, so the
	// prompt can never be answered and we deadlock waiting on a child that
	// will never exit.
	//
	// Invoking concurrently's bin script under node directly removes the
	// cmd.exe layer entirely. We resolve it via package.json (the only
	// exported subpath) rather than hardcoding dist/bin, so this survives
	// upstream layout changes.
	const require = createRequire(import.meta.url);
	const manifestPath = require.resolve("concurrently/package.json");
	const bin = join(dirname(manifestPath), require(manifestPath).bin.concurrently);
	child = spawn(process.execPath, [bin, ...args], { stdio: "inherit" });
} else {
	// POSIX: Ctrl+C signals the whole foreground process group, sh exits
	// without prompting, and `concurrently -k` reaps its own children.
	const command = [
		"concurrently -k -r",
		'"pnpm:dev"',
		'"pnpm:electron:watch"',
		'"wait-on http://localhost:5173 && pnpm electron:compile && pnpm electron:start"',
	].join(" ");
	child = spawn(command, { shell: true, stdio: "inherit" });
}

let userInterrupted = false;
let forceKillTimer;

// concurrently still spawns each individual command through a shell, so on
// Windows a grandchild cmd.exe can in principle park on the same prompt.
// If the tree hasn't exited within the grace period, take it down by force.
function armForceKill() {
	if (!isWindows || forceKillTimer || child.exitCode !== null) return;
	forceKillTimer = setTimeout(() => {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
		}).unref();
	}, WINDOWS_KILL_GRACE_MS);
	forceKillTimer.unref();
}

process.on("SIGINT", () => {
	userInterrupted = true;
	// Still don't exit here — wait for the child's exit event so its cleanup
	// (engine sidecar graceful shutdown etc.) gets a chance to finish.
	armForceKill();
});
process.on("SIGTERM", () => {
	userInterrupted = true;
	armForceKill();
});

child.on("exit", (code, signal) => {
	clearTimeout(forceKillTimer);
	if (userInterrupted || signal === "SIGINT" || signal === "SIGTERM" || code === 130) {
		process.exit(0);
	}
	process.exit(code ?? 1);
});
