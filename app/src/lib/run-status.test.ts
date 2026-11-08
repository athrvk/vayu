/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The run-status predicates, over every status the engine writes plus the
 * inputs that are neither (#3351). Mutation check: make `isRunTerminal` accept
 * "pending" and the table goes red.
 */

import { describe, it, expect } from "vitest";
import { isRunInProgress, isRunLive, isRunTerminal } from "./run-status";

const STATUSES: ReadonlyArray<{
	status: string | null | undefined;
	inProgress: boolean;
	terminal: boolean;
}> = [
	{ status: "pending", inProgress: true, terminal: false },
	{ status: "running", inProgress: true, terminal: false },
	{ status: "completed", inProgress: false, terminal: true },
	{ status: "stopped", inProgress: false, terminal: true },
	{ status: "failed", inProgress: false, terminal: true },
	// Neither: an engine newer than this client, or a row with no status.
	{ status: "paused", inProgress: false, terminal: false },
	{ status: "Completed", inProgress: false, terminal: false },
	{ status: "", inProgress: false, terminal: false },
	{ status: null, inProgress: false, terminal: false },
	{ status: undefined, inProgress: false, terminal: false },
];

describe("run status predicates", () => {
	it.each(STATUSES)("isRunInProgress($status) is $inProgress", ({ status, inProgress }) => {
		expect(isRunInProgress(status)).toBe(inProgress);
	});

	it.each(STATUSES)("isRunTerminal($status) is $terminal", ({ status, terminal }) => {
		expect(isRunTerminal(status)).toBe(terminal);
	});
});

describe("isRunLive", () => {
	// Mutation check: drop the terminal early return and a stream that has not
	// caught up keeps a finished run on "still running" in History.
	it.each(STATUSES)("$status with a live stream", ({ status, terminal }) => {
		expect(isRunLive(status, true)).toBe(!terminal);
	});

	// Mutation check: answer from the stream alone and a tab reopened onto a
	// run still executing, with no stream in this window, offers no Stop.
	it.each(STATUSES)("$status with no stream", ({ status, inProgress }) => {
		expect(isRunLive(status, false)).toBe(inProgress);
	});
});
