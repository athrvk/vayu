/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The flattening, pinned across the two implementations of it (issue #877).
 *
 * The parse moved engine-side and this did not, for a reason: the app applies a
 * result a person has *previewed and filtered* - which files of a batch to
 * include, what the two option toggles did to them - while `POST /import`
 * applies a document nobody looked at. So the same mapping exists twice, and a
 * field added to one and missed by the other is silent in exactly the way this
 * subsystem's defects always are: a request that imported without its examples
 * looks identical to a document that documented none.
 *
 * `engine/tests/fixtures/import-conformance.json` is the pin. Each case carries
 * the `payload` this orchestrator produced for its `expected` result, and the
 * engine's `import_parse_test.cpp` asserts `core::import_apply_payload` produces
 * the same one. Adding a draft field means adding it to both, and whichever side
 * forgets goes red.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assignTempIds } from "./assign-ids";
import { ImportOrchestrator, type ImportApi } from "./orchestrator";
import type { ImportResult } from "./types";
import type { ImportApplyRequest } from "@/types";

const FIXTURE = join(__dirname, "../../../../engine/tests/fixtures/import-conformance.json");

interface Case {
	name: string;
	expected: ImportResult;
	payload: ImportApplyRequest;
}

const cases = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: Case[] }).cases;

/** Records the one payload a run sends, and answers with an id for every item. */
function recorder(): { api: ImportApi; sent: ImportApplyRequest[] } {
	const sent: ImportApplyRequest[] = [];
	const api: ImportApi = {
		applyImport: async (payload) => {
			sent.push(payload);
			const idMap: Record<string, string> = {};
			for (const kind of ["collections", "requests", "environments"] as const) {
				for (const item of payload[kind]) idMap[item.tempId] = `x_${item.tempId}`;
			}
			for (const item of payload.specs) idMap[item.tempId] = `x_${item.tempId}`;
			return { idMap };
		},
		getGlobals: async () => ({ id: "g", variables: {}, updatedAt: "0" }),
		updateGlobals: async (variables) => ({ id: "g", variables, updatedAt: "1" }),
	};
	return { api, sent };
}

describe("the apply payload both sides build", () => {
	it("has cases to check", () => {
		// A fixture that shrank to nothing would pass every assertion below.
		expect(cases.length).toBeGreaterThan(10);
	});

	it.each(cases.map((entry) => [entry.name, entry] as const))(
		"flattens %s exactly as the engine does",
		async (_name, entry) => {
			const { api, sent } = recorder();
			const result = assignTempIds(
				JSON.parse(JSON.stringify(entry.expected)) as ImportResult
			);
			await new ImportOrchestrator(api).run(result, {
				importEnvironments: true,
				importScripts: true,
			});
			expect(sent[0]).toEqual(entry.payload);
		}
	);
});
