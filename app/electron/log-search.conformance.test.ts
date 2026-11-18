/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Logs tab's search box is read twice (#3635): the renderer parses it into
 * what it sends, and `log-reader.ts` is the reader that evaluates it, with its
 * own `parseSearchInput` (`src/` may not import from `electron/`, so the
 * renderer holds a copy). The copy is pinned here, from the side that may
 * import both: they are run over the same inputs and must answer alike.
 *
 * The inputs are a hand-written list of the grammar's edges plus every
 * combination of a few tokens, so a rule changed on one side alone reds with
 * the input that shows it.
 *
 * Mutation check: change `FIELD_NAME` or the `//` rule in
 * `src/modules/logs/parse-search.ts` and the case below reds.
 */

import { describe, expect, it } from "vitest";
import { parseSearchInput as readerParse } from "./log-reader";
import { parseSearchInput as rendererParse } from "@/modules/logs/parse-search";

const EDGES = [
	"",
	"   ",
	"token failed",
	`token failed status:500 cat:"oauth" "two  words" runId:"a b"`,
	"http://host/x status: Status:5 :x",
	`cat:"oauth"x`,
	`a:"unterminated`,
	`"unterminated`,
	`cat:""`,
	`x:"a" y:"b" z:c`,
	"a::b a:b:c",
	"snake_case:1 camelCase:2 9lives:3",
];

const TOKENS = [
	"word",
	"cat:oauth",
	`cat:"oauth"`,
	`"a b"`,
	"url:http://h",
	"x://y",
	"status:",
	`runId:"a b"`,
	":x",
	"Upper:1",
];

function combinations(depth: number): string[] {
	if (depth === 0) return [""];
	const shorter = combinations(depth - 1);
	return TOKENS.flatMap((token) => shorter.map((rest) => `${token} ${rest}`.trimEnd()));
}

const INPUTS = [...EDGES, ...combinations(1), ...combinations(2), ...combinations(3)];

describe("the search box's grammar, renderer and main", () => {
	it("ran over a non-empty list of inputs", () => {
		expect(INPUTS.length).toBeGreaterThan(1000);
		expect(rendererParse("cat:oauth").terms).toHaveLength(1);
	});

	it("answers every input alike", () => {
		const differing = INPUTS.filter(
			(input) => JSON.stringify(rendererParse(input)) !== JSON.stringify(readerParse(input))
		);
		expect(differing).toEqual([]);
	});
});
