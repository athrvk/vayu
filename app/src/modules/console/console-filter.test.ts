/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Console's filter predicate (#3634), at the edges the list's own cases do
 * not reach: what a query finds on each row kind, and what counts as narrowing.
 */

import { describe, expect, it } from "vitest";
import type { ConsoleRow } from "@/stores/console-store";
import {
	NO_CONSOLE_FILTER,
	consoleRowMatcher,
	filterConsoleRows,
	narrowsConsole,
	type ConsoleFilter,
} from "./console-filter";

const at = { id: 1, at: 0 };

const failedSend: ConsoleRow = {
	...at,
	kind: "send",
	method: "GET",
	url: "https://api.test/down",
	status: 0,
	timeMs: 0,
	sizeBytes: 0,
	errorCode: "CONNECTION_FAILED",
	exchange: { requestHeaders: {}, responseHeaders: {} },
};

const scriptRequest: ConsoleRow = {
	...at,
	kind: "scriptRequest",
	source: "test",
	method: "POST",
	url: "http://localhost:4000/token",
	status: 201,
	timeMs: 3,
	sizeBytes: 9,
	line: "POST http://localhost:4000/token 201 issued",
	exchange: { requestHeaders: {}, responseHeaders: {} },
};

const step: ConsoleRow = {
	...at,
	kind: "step",
	runId: "run_1",
	iteration: 0,
	stepIndex: 0,
	name: "Create order",
	outcome: "failed",
	status: 422,
	timeMs: 8,
};

const query = (text: string): ConsoleFilter => ({ ...NO_CONSOLE_FILTER, query: text });

describe("the Console's filter", () => {
	it("narrows nothing for a whitespace-only query, and hands the rows back as they are", () => {
		const rows = [failedSend, step];
		expect(narrowsConsole(query("   "))).toBe(false);
		expect(filterConsoleRows(rows, query("   "))).toBe(rows);
	});

	it("finds a failure by its error code, never by a status of 0", () => {
		expect(consoleRowMatcher(query("connection_failed"))(failedSend)).toBe(true);
		expect(consoleRowMatcher(query("0"))(failedSend)).toBe(false);
	});

	it("finds a script request by the line it stands in for", () => {
		expect(consoleRowMatcher(query("issued"))(scriptRequest)).toBe(true);
	});

	it("finds a step by its name and its status", () => {
		expect(consoleRowMatcher(query("create order"))(step)).toBe(true);
		expect(consoleRowMatcher(query("422"))(step)).toBe(true);
	});

	it("shows no request row while a level is chosen", () => {
		const errors: ConsoleFilter = { ...NO_CONSOLE_FILTER, level: "error" };
		expect(consoleRowMatcher(errors)(failedSend)).toBe(false);
		expect(consoleRowMatcher(errors)(step)).toBe(false);
	});
});
