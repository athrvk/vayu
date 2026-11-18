/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, it } from "vitest";
import { parseSearchInput } from "./parse-search";

describe("parseSearchInput", () => {
	it("splits a search into free text and field terms", () => {
		expect(
			parseSearchInput(`token failed status:500 cat:"oauth" "two  words" runId:"a b"`)
		).toEqual({
			text: "token failed two  words",
			terms: [
				{ field: "status", value: "500", exact: false },
				{ field: "cat", value: "oauth", exact: true },
				{ field: "runId", value: "a b", exact: true },
			],
		});
	});

	it("reads a bare value as a substring and a quoted one as exact", () => {
		expect(parseSearchInput(`cat:oauth cat:"oauth"`).terms).toEqual([
			{ field: "cat", value: "oauth", exact: false },
			{ field: "cat", value: "oauth", exact: true },
		]);
	});

	it("leaves a URL, an empty value and a name that is not a field name in the free text", () => {
		expect(parseSearchInput("http://host/x status: Status:5 :x")).toEqual({
			text: "http://host/x status: Status:5 :x",
			terms: [],
		});
	});

	it("keeps a value that starts // as free text and a URL after a field as a term", () => {
		expect(parseSearchInput("scheme://host url:http://host")).toEqual({
			text: "scheme://host",
			terms: [{ field: "url", value: "http://host", exact: false }],
		});
	});

	it("answers nothing for an empty search", () => {
		expect(parseSearchInput("   ")).toEqual({ text: "", terms: [] });
	});
});
