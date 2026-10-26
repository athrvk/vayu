/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file output-schema.conformance.test.ts
 * @brief Every read tool declares an `outputSchema`, or is on the reasoned
 *        exception list below (#2445).
 *
 * A read whose answer an agent has to parse is a contract, and a contract with
 * no declared shape is one an agent learns by trial. A new read tool therefore
 * fails here until it declares a schema or names why it cannot; an exception
 * that stops being true fails too, so the list cannot rot into a second place
 * to forget.
 */

import { describe, expect, test } from "vitest";
import { TOOLS } from "./tools.js";

/** An outputSchema is object-rooted, and reshaping the array would break every agent reading it. */
const BARE_ARRAY = "answers a bare JSON array; an outputSchema is object-rooted";

/** Read tools that declare no `outputSchema`, each with the reason it cannot. */
const EXCEPTIONS: Readonly<Record<string, string>> = {
	list_environments: BARE_ARRAY,
	list_client_certificates: BARE_ARRAY,
	export_run_report:
		"answers the document's own text (Markdown by default), not a JSON object, so there is nothing to wrap",
};

/** Read tools at the time of writing; a floor, so adding a tool never fails the count. */
const READ_TOOLS_AT_WRITING = 36;

const readTools = TOOLS.filter((tool) => tool.category === "read");

describe("every read tool declares an outputSchema or names why it cannot", () => {
	test("scans the read tools", () => {
		expect(readTools.length).toBeGreaterThanOrEqual(READ_TOOLS_AT_WRITING);
	});

	test("no read tool is without both", () => {
		const undeclared = readTools
			.filter((tool) => !tool.outputSchema && !(tool.name in EXCEPTIONS))
			.map((tool) => tool.name);
		expect(undeclared).toEqual([]);
	});

	test("every exception names a read tool that exists", () => {
		const names = new Set(readTools.map((tool) => tool.name));
		const unknown = Object.keys(EXCEPTIONS).filter((name) => !names.has(name));
		expect(unknown).toEqual([]);
	});

	test("no excepted tool also declares a schema", () => {
		const stale = readTools
			.filter((tool) => tool.outputSchema && tool.name in EXCEPTIONS)
			.map((tool) => tool.name);
		expect(stale).toEqual([]);
	});

	test("every exception states a reason", () => {
		const unreasoned = Object.entries(EXCEPTIONS)
			.filter(([, reason]) => reason.trim() === "")
			.map(([name]) => name);
		expect(unreasoned).toEqual([]);
	});
});
