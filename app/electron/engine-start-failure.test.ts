/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A failed engine start keeps the window, and the Dock gets a reason (#3610).
 *
 * The last branch of `startEngine`'s catch used to show "Couldn't start Vayu's
 * engine" in a native box and quit; the quit then asked a page that had not
 * loaded to flush, and the 2s ceiling put "Couldn't save some edits" on screen
 * over a session with nothing edited. A failure with no child now records one
 * sentence for `engine:startFailure`, and one with a crashed child leaves the
 * reason to the lifecycle. `restartEngine` reads the same classification, so a
 * Retry that fails the same way keeps the same reason.
 *
 * Mutation checks: put the error box and `app.quit()` back in `startEngine` and
 * the main.ts wiring case reddens; return `reason: null` for a childless failure
 * and "records a sentence" reddens; drop the `crashed` check and "leaves the
 * reason to the crash" reddens.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";

// sidecar.ts imports `app` for its paths; nothing here reaches them.
vi.mock("electron", () => ({ app: {} }));

import {
	classifyEngineStartFailure,
	engineStartFailureReason,
	logEngineStartFailure,
	type EngineStartState,
} from "./engine-start-failure";
import { EngineNotReadyError, EnginePortInUseError, type EngineLifecycle } from "./sidecar";

const CRASHED: EngineLifecycle = {
	kind: "crashed",
	code: 3,
	signal: null,
	stderrTail: ["database is locked"],
	error: null,
};

function sidecar(
	options: { lifecycle?: EngineLifecycle; shuttingDown?: boolean; restartPending?: boolean } = {}
): EngineStartState {
	return {
		isShuttingDown: () => options.shuttingDown ?? false,
		hasRestartPending: () => options.restartPending ?? false,
		getLifecycle: () => options.lifecycle ?? { kind: "idle" },
	};
}

const MISSING_BINARY = new Error(
	"Engine binary not found at: /opt/vayu/bin/vayu-engine\n\n" +
		"From a source checkout, build it with:\n  python build.py -e"
);

describe("classifyEngineStartFailure", () => {
	it("reads a spent readiness budget as slow, with nothing to record", () => {
		const outcome = classifyEngineStartFailure(new EngineNotReadyError(45_000), sidecar());
		expect(outcome).toEqual({ kind: "slow" });
		expect(engineStartFailureReason(outcome)).toBeNull();
	});

	it("records the held-port sentence as written", () => {
		const error = new EnginePortInUseError([9876]);
		const outcome = classifyEngineStartFailure(error, sidecar());
		expect(outcome.kind).toBe("port-in-use");
		expect(engineStartFailureReason(outcome)).toBe(error.message);
	});

	it.each([
		["a quit", { shuttingDown: true }],
		["a queued restart", { restartPending: true }],
	])("reads a start overtaken by %s as overtaken, with nothing to record", (_name, state) => {
		const outcome = classifyEngineStartFailure(MISSING_BINARY, sidecar(state));
		expect(outcome).toEqual({ kind: "overtaken" });
		expect(engineStartFailureReason(outcome)).toBeNull();
	});

	it("records a sentence for a failure that never had a child", () => {
		const outcome = classifyEngineStartFailure(MISSING_BINARY, sidecar());
		expect(outcome.kind).toBe("failed");
		// One line: the remediation paragraphs stay in the log, not in a tooltip
		// that collapses them into one run-on string.
		expect(engineStartFailureReason(outcome)).toBe(
			"Couldn't start Vayu's engine: Engine binary not found at: /opt/vayu/bin/vayu-engine"
		);
	});

	it("leaves the reason to the crash when the child exited", () => {
		const exited = new Error("Vayu's engine exited before it was ready (exit code 3).");
		const outcome = classifyEngineStartFailure(exited, sidecar({ lifecycle: CRASHED }));
		expect(outcome).toEqual({ kind: "failed", reason: null });
	});

	it("names a failed restart's last attempt, not the wrapper around it", () => {
		// `restart()` wraps its last attempt's error as `cause`.
		const wrapped = new Error(
			`Nothing answered after 4 attempts (${MISSING_BINARY.message}). Quit Vayu and open it again.`,
			{ cause: MISSING_BINARY }
		);
		expect(engineStartFailureReason(classifyEngineStartFailure(wrapped, sidecar()))).toBe(
			"Couldn't start Vayu's engine: Engine binary not found at: /opt/vayu/bin/vayu-engine"
		);
	});

	it("still says something for a thrown value with no text", () => {
		expect(engineStartFailureReason(classifyEngineStartFailure(new Error(""), null))).toBe(
			"Couldn't start Vayu's engine."
		);
	});

	it("survives a cause chain that loops", () => {
		const a = new Error("first");
		const b = new Error("second", { cause: a });
		Object.assign(a, { cause: b });
		expect(engineStartFailureReason(classifyEngineStartFailure(a, null))).toMatch(
			/^Couldn't start Vayu's engine: (first|second)$/
		);
	});
});

describe("logEngineStartFailure", () => {
	it.each([
		["slow", new EngineNotReadyError(45_000), sidecar(), "warn"],
		["port-in-use", new EnginePortInUseError([9876]), sidecar(), "warn"],
		["overtaken", MISSING_BINARY, sidecar({ shuttingDown: true }), "info"],
		["failed", MISSING_BINARY, sidecar(), "error"],
	] as const)("logs %s at %s, with the error", (_kind, error, state, level) => {
		const log = vi.fn();
		logEngineStartFailure(classifyEngineStartFailure(error, state), error, log);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(level, expect.any(String), { error: String(error) });
	});
});

/*
 * main.ts creates windows and starts the engine at import time, so its half can
 * only be read. Every case above would still pass with a catch block that
 * classified and then quit anyway, which is the defect.
 */
describe("main.ts wiring", () => {
	const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
	/** The catch block of the top-level function `name`, up to that function's end. */
	function catchOf(name: string): string {
		const fn = main.slice(main.indexOf(`async function ${name}(`));
		return fn.slice(fn.indexOf("} catch (error) {"), fn.indexOf("\n}\n"));
	}
	const startCatch = catchOf("startEngine");
	const restartCatch = catchOf("restartEngine");

	it("read the real start and restart", () => {
		// A guard that scanned an empty string would pass every assertion below.
		expect(startCatch.length).toBeGreaterThan(100);
		expect(restartCatch.length).toBeGreaterThan(100);
	});

	it("keeps the window on a failed first start: no error box, no quit", () => {
		expect(startCatch).toContain("classifyEngineStartFailure(error, engineSidecar)");
		expect(startCatch).toContain("engineStartFailure = engineStartFailureReason(outcome)");
		expect(startCatch).not.toContain("showErrorBox");
		expect(startCatch).not.toContain("app.quit()");
	});

	it("classifies a failed restart the same way", () => {
		expect(restartCatch).toMatch(
			/engineStartFailure = engineStartFailureReason\(\s*classifyEngineStartFailure\(error, engineSidecar\)\s*\)/
		);
	});
});
