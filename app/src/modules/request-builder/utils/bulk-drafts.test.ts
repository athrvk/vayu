/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a Bulk edit draft writes when it commits - from the table toggle, Send
 * or Save alike (#3666). The provider-level behaviour is
 * `context/RequestBuilderProvider.bulk-drafts.test.tsx`.
 *
 * Mutation check: drop the `isNoOpHeadersEdit` guard in `bulkTextPatch` and
 * "commits nothing for the headers it was opened on" goes red (the round trip
 * re-enables the disabled row, #1480); the params case is the same for
 * `isNoOpParamsEdit`.
 */

import { describe, it, expect } from "vitest";
import type { KeyValueItem } from "@/types";
import { createDefaultRequestState } from "./request-state";
import { formatHeadersToText } from "./headers-format";
import { formatParamsToText } from "./params-format";
import {
	bulkDraftsPatch,
	bulkTextPatch,
	queryTablePatch,
	unreadLineNotices,
	unreadLinesNotice,
} from "./bulk-drafts";

const headers: KeyValueItem[] = [
	{ id: "1", key: "Accept", value: "*/*", enabled: true },
	{ id: "2", key: "Authorization", value: "Bearer abc", enabled: false },
];
const params: KeyValueItem[] = [
	{ id: "p1", key: "page", value: "1", enabled: true },
	{ id: "p2", key: "debug", value: "1", enabled: false },
	{ id: "path", key: "id", value: "7", enabled: true, in: "path" },
];
const request = {
	...createDefaultRequestState(),
	url: "https://api.test/users/:id?page=1",
	params,
	headers,
};

describe("a draft committed unchanged", () => {
	it("commits nothing for the headers it was opened on", () => {
		expect(bulkTextPatch(request, "headers", formatHeadersToText(headers))).toBeNull();
	});

	it("commits nothing for the params it was opened on", () => {
		expect(bulkTextPatch(request, "params", formatParamsToText(params))).toBeNull();
	});
});

describe("a draft committed with edits", () => {
	it("writes the edited headers, ending in a blank row to type into", () => {
		const text = formatHeadersToText(headers).replace("// Authorization", "Authorization");
		const patch = bulkTextPatch(request, "headers", text);
		const written = patch?.headers ?? [];
		expect(written.find((h) => h.key === "Authorization")?.enabled).toBe(true);
		expect(written[written.length - 1]).toMatchObject({ key: "", value: "" });
	});

	it("rewrites the URL's query and keeps the path rows the text never shows", () => {
		const patch = bulkTextPatch(request, "params", "page=2\nsort=name");
		expect(patch?.url).toBe("https://api.test/users/:id?page=2&sort=name");
		expect(patch?.params?.map((p) => p.key)).toEqual(["page", "sort", "id"]);
	});

	it("is the table's own rule", () => {
		// The Params table's edit and a params draft's commit write the same.
		const rows: KeyValueItem[] = [{ id: "n", key: "page", value: "2", enabled: true }];
		expect(queryTablePatch(request, rows).url).toBe("https://api.test/users/:id?page=2");
	});
});

describe("every open draft at once", () => {
	it("merges the params and the headers drafts", () => {
		const patch = bulkDraftsPatch(request, {
			params: { text: "page=3", opened: "" },
			headers: { text: "X-Trace: on", opened: "" },
		});
		expect(patch?.url).toBe("https://api.test/users/:id?page=3");
		expect(patch?.headers?.[0]).toMatchObject({ key: "X-Trace", value: "on" });
	});

	it("is null when no draft would change anything", () => {
		expect(bulkDraftsPatch(request, {})).toBeNull();
		expect(
			bulkDraftsPatch(request, {
				headers: { text: formatHeadersToText(headers), opened: "" },
			})
		).toBeNull();
	});
});

describe("unreadLinesNotice (#3694)", () => {
	it("names each line, singular for one", () => {
		expect(unreadLinesNotice("headers", [{ lineNumber: 3, text: "nocolon" }])).toBe(
			'Headers: 1 line not read: line 3 "nocolon"'
		);
		expect(
			unreadLinesNotice("params", [
				{ lineNumber: 3, text: "nocolon" },
				{ lineNumber: 5, text: "=novalue" },
			])
		).toBe('Params: 2 lines not read: line 3 "nocolon", line 5 "=novalue"');
	});

	it("names at most three lines and counts the rest", () => {
		const unread = [1, 2, 3, 4, 5].map((lineNumber) => ({ lineNumber, text: "x" }));
		expect(unreadLinesNotice("params", unread)).toBe(
			'Params: 5 lines not read: line 1 "x", line 2 "x", line 3 "x", and 2 more'
		);
	});

	it("cuts a long line's text", () => {
		const notice = unreadLinesNotice("headers", [{ lineNumber: 1, text: "y".repeat(200) }]);
		expect(notice).toBe(`Headers: 1 line not read: line 1 "${"y".repeat(40)}…"`);
	});

	it("is null when nothing was left out", () => {
		expect(unreadLinesNotice("headers", [])).toBeNull();
	});
});

describe("unreadLineNotices (#3694)", () => {
	const draft = (text: string) => ({ text, opened: "" });

	it("says nothing for a clean round trip of the rows the table holds", () => {
		expect(
			unreadLineNotices({
				headers: draft(formatHeadersToText(headers)),
				params: draft(formatParamsToText(params)),
			})
		).toEqual([]);
	});

	it("speaks for a draft the no-op guard commits nothing for", () => {
		const text = `${formatHeadersToText(headers)}\nnocolon`;
		expect(bulkTextPatch(request, "headers", text)).toBeNull();
		expect(unreadLineNotices({ headers: draft(text) })).toEqual([
			'Headers: 1 line not read: line 3 "nocolon"',
		]);
	});

	it("reports each open table on its own, in table order", () => {
		expect(unreadLineNotices({ headers: draft("nocolon"), params: draft("=novalue") })).toEqual(
			[
				'Params: 1 line not read: line 1 "=novalue"',
				'Headers: 1 line not read: line 1 "nocolon"',
			]
		);
		expect(unreadLineNotices({})).toEqual([]);
	});
});
