/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: the request an import of a document builds here,
 * against the one the engine derives from the same document (issue #865,
 * `engine/tests/openapi_drafts_test.cpp` reads the same table).
 *
 * A draft is not an identity - it is **the request an import would build** - and
 * the spec sync diff compares a stored request against one, field by field. So
 * a divergence here fails nothing loudly: it reads as *the document changed this
 * request*, offering a rename on a document nobody edited, or reporting a user's
 * own edit as the document's. The identity half is pinned by
 * `declared-operations.conformance.test.ts`; this is the half the diff actually
 * compares.
 *
 * Read from the engine tree on purpose, like the other conformance suites: one
 * file, two readers, no copy to drift.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readSpecOperations, type SpecRequestDraft } from "./spec-operations";
import type { KeyValueEntry } from "@/types";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
	here,
	"..",
	"..",
	"..",
	"..",
	"engine",
	"tests",
	"fixtures",
	"spec-request-drafts-conformance.json"
);

interface FixtureRow {
	key: string;
	value: string;
	enabled: boolean;
	description: string;
	file: boolean;
}

interface FixtureDraft {
	operationId?: string;
	method: string;
	path: string;
	folder: string;
	name: string;
	description: string;
	url: string;
	params: FixtureRow[];
	headers: FixtureRow[];
	body: { mode: string; content: string; fields: FixtureRow[] };
}

interface FixtureCase {
	name: string;
	document: string;
	drafts: FixtureDraft[];
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: FixtureCase[] };

function rows(entries: readonly (KeyValueEntry & { type?: string })[] | undefined): FixtureRow[] {
	return (entries ?? []).map((entry) => ({
		key: entry.key,
		value: entry.value,
		enabled: entry.enabled,
		description: entry.description ?? "",
		// A multipart part the document declares as an upload is a different row
		// from a text one even when both are empty (issue #425).
		file: entry.type === "file",
	}));
}

function shapeOf(entry: SpecRequestDraft): FixtureDraft {
	const { body } = entry.draft;
	return {
		...(entry.operation.operationId ? { operationId: entry.operation.operationId } : {}),
		method: entry.operation.method,
		path: entry.operation.path,
		folder: entry.folder,
		name: entry.draft.name,
		description: entry.draft.description,
		url: entry.draft.url,
		params: rows(entry.draft.params),
		headers: rows(entry.draft.headers),
		body: {
			mode: body.mode,
			content: "content" in body ? body.content : "",
			fields: "fields" in body ? rows(body.fields) : [],
		},
	};
}

describe("spec request draft conformance with the engine", () => {
	it("reads a fixture with cases to check", () => {
		// A fixture that failed to load reads as a suite of passing tests - the
		// failure mode a source-scanning guard in this repo shipped with for weeks.
		expect(fixture.cases.length).toBeGreaterThanOrEqual(5);
		expect(fixture.cases.flatMap((c) => c.drafts).length).toBeGreaterThanOrEqual(10);
	});

	for (const testCase of fixture.cases) {
		it(`builds the requests the engine derives: ${testCase.name}`, () => {
			// Keyed rather than ordered: the engine walks the document while
			// `readSpecOperations` walks the collection tree it built (root
			// requests, then tag folders). Two orders both sides agree about.
			const built = new Map(
				readSpecOperations(testCase.document).requests.map((entry) => {
					const shape = shapeOf(entry);
					return [`${shape.method} ${shape.path}`, shape];
				})
			);
			expect(built.size).toBe(testCase.drafts.length);
			for (const expected of testCase.drafts) {
				expect(built.get(`${expected.method} ${expected.path}`)).toEqual(expected);
			}
		});
	}
});
