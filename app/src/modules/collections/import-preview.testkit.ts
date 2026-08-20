/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the import dialog is handed, for the tests that are about the dialog
 * (issue #877).
 *
 * These cases used to feed a document and assert on the preview it produced,
 * which quietly made every one of them a parser test as well: a change to how
 * Postman's `file` body was tallied broke the case about the *word* the preview
 * prints. The parse is the engine's now, so the coupling has to go anyway - and
 * saying it out loud is the better test. Each case states the `ImportResult` it
 * is previewing, and what the dialog does with it is the only thing under
 * assertion.
 *
 * What a document actually parses to is pinned where the parse lives:
 * `engine/tests/fixtures/import-conformance.json`, whose every expectation was
 * recorded from the renderer's own parsers before they were deleted.
 */

import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiService } from "@/services/api";
import { ApiError } from "@/services/http-client";
import type { ImportParseRequest } from "@/types";
import type {
	CollectionDraft,
	ImportMeta,
	ImportResult,
	RequestDraft,
} from "@/services/importers/types";

/** A parse that found nothing to report - every counter answered, all zero. */
export function meta(over: Partial<ImportMeta> = {}): ImportMeta {
	return {
		format: "Postman Collection v2.1",
		requestCount: 0,
		folderCount: 0,
		environmentCount: 0,
		globalCount: 0,
		exampleCount: 0,
		skipped: [],
		nonExecutableAuth: 0,
		unattachedFileParts: 0,
		...over,
	};
}

export function request(over: Partial<RequestDraft> = {}): RequestDraft {
	return {
		name: "A request",
		description: "",
		method: "GET",
		url: "https://api.example.com/thing",
		params: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
		...over,
	};
}

export function collection(over: Partial<CollectionDraft> = {}): CollectionDraft {
	return {
		name: "A collection",
		description: "",
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		children: [],
		requests: [],
		...over,
	};
}

/**
 * `meta` is a *partial* here while the rest of the result is not: a case states
 * the one counter it is about (`unattachedFileParts: 1`) and lets the others
 * answer 0, the way a parse that found nothing would.
 */
export function result(
	over: Partial<Omit<ImportResult, "meta">> & { meta?: Partial<ImportMeta> } = {}
): ImportResult {
	const { meta: metaOver, ...rest } = over;
	const collections = rest.collections ?? [collection()];
	return {
		collections,
		environments: [],
		globals: {},
		...rest,
		meta: meta({
			requestCount: countRequests(collections),
			...metaOver,
		}),
	};
}

function countRequests(collections: CollectionDraft[]): number {
	let count = 0;
	for (const c of collections) count += c.requests.length + countRequests(c.children);
	return count;
}

/**
 * Answer every parse the dialog makes with @p answer, and every document read
 * with `JSON.parse`.
 *
 * `null` is "no format claims this", which the engine says as a 400 carrying
 * that exact sentence and `factory.ts` turns back into `UnrecognisedFormatError`
 * - so a case about the unrecognised-file row exercises the real path rather
 * than a thrown stub.
 *
 * `readDocument` is stubbed too: the ref bundler reads a document into a tree
 * through the engine (issue #877), and a dialog test has none running.
 */
export function stubParse(
	answer: (payload: ImportParseRequest) => ImportResult | null
): ReturnType<typeof vi.spyOn> {
	vi.spyOn(apiService, "readDocument").mockImplementation(async (text: string) =>
		JSON.parse(text)
	);
	return vi.spyOn(apiService, "parseImport").mockImplementation(async (payload) => {
		const parsed = answer(payload);
		if (!parsed) throw new ApiError(400, "BAD_REQUEST", "Unrecognised format");
		return parsed;
	});
}

/**
 * The recorded parse of a fixture document (issue #877).
 *
 * Not a hand-written stand-in: `engine/tests/fixtures/import-conformance.json`
 * carries what the renderer's own parsers produced for each of these documents,
 * recorded at the commit before they were deleted and asserted against the
 * engine's parse on every build. So a case that pastes `postman-v21.json` and
 * previews it is looking at the same tree a running engine would answer with.
 */
export function recordedParse(name: string): ImportResult {
	const fixture = JSON.parse(
		readFileSync(
			join(__dirname, "../../../../engine/tests/fixtures/import-conformance.json"),
			"utf8"
		)
	) as { cases: { name: string; expected: ImportResult }[] };
	const found = fixture.cases.find((entry) => entry.name === name);
	if (!found) throw new Error(`no recorded parse named "${name}"`);
	return found.expected;
}
