/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The secrets invariant, held at the source rather than at the screen.
 *
 * A rendered assertion cannot hold this one. cmdk filters the palette's list a
 * second time, on the row's own value and keywords, so a source that indexed
 * values would still show nothing for a query that matched only a value - the
 * leak would sit in the produced items, invisible to the DOM and one keyword
 * change away from being searchable. So this reads what the hook returns.
 *
 * Mutation check for the `{{name}}` spelling (#3323): stop stripping the braces
 * in `keyNeedle` and the "finds a variable by its `{{name}}` spelling" cases
 * fail; drop the `{{key}}` keyword and the score assertion fails.
 *
 * Mutation check: make `matchRank` fall back to the variable's value, or append
 * values to `keywords`, and the assertions below fail.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useVariableItems } from "./useVariableItems";
import { MATCH_FLOOR, scoreItem } from "../ranking";
import type { PaletteItem } from "../types";

/** Distinct enough that finding it anywhere in the output is unambiguous. */
const SECRET_VALUE = "s3cr3t-bearer-value";
const PLAIN_VALUE = "https://pay.example";

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({
		data: [
			{
				id: "c1",
				name: "Payments",
				// Not flagged secret, and still never indexed: `secret` is a
				// masking hint, so a rule that trusted it would leak every token
				// nobody remembered to flag.
				variables: { chargeBaseUrl: { value: PLAIN_VALUE } },
			},
		],
	}),
	useEnvironmentsQuery: () => ({
		data: [
			{
				id: "e1",
				name: "Production",
				variables: { apiToken: { value: SECRET_VALUE, secret: true } },
			},
			{ id: "e2", name: "Staging EU", variables: {} },
		],
	}),
	useGlobalsQuery: () => ({
		data: { id: "globals", variables: { retryBudget: { value: "3" } } },
	}),
}));

/** Everything a row could carry a value in - the whole item bar its handler. */
function indexedText(items: PaletteItem[]): string {
	return JSON.stringify(items.map(({ perform: _perform, icon: _icon, ...rest }) => rest));
}

function items(query: string): PaletteItem[] {
	return renderHook(() => useVariableItems(query)).result.current;
}

describe("the secrets invariant", () => {
	it("indexes a variable's key, and nothing of its value", () => {
		const found = items("apiToken");

		expect(found.map((item) => item.title)).toEqual(["apiToken"]);
		expect(found[0].subtitle).toBe("Production");
		expect(indexedText(found)).not.toContain(SECRET_VALUE);
	});

	it("cannot be searched by a value, secret or not", () => {
		expect(items("s3cr3t")).toEqual([]);
		expect(items("pay.example")).toEqual([]);
	});

	it("carries no value on any row, whatever the query matched", () => {
		for (const query of ["apiToken", "chargeBaseUrl", "retryBudget", "Production"]) {
			const text = indexedText(items(query));
			expect(text).not.toContain(SECRET_VALUE);
			expect(text).not.toContain(PLAIN_VALUE);
		}
	});
});

describe("scoping", () => {
	it("names the scope that defines each key", () => {
		expect(items("retryBudget")[0].subtitle).toBe("Globals");
		expect(items("chargeBaseUrl")[0].subtitle).toBe("Payments");
	});

	it("contributes nothing to the empty query", () => {
		expect(items("")).toEqual([]);
		expect(items("   ")).toEqual([]);
	});

	it("puts a scope whose own name matches above a key in another scope", () => {
		// "Production" is an environment name; nothing else here matches it.
		const found = items("Production");
		expect(found[0].title).toBe("Production");
		expect(found[0].subtitle).toBe("Environment");
	});
});

describe("finds a variable by its `{{name}}` spelling", () => {
	it.each(["{{retryBudget}}", "{{retry", "{{ retryBudget }}", "retryBudget}}"])(
		"%s returns the variable row",
		(query) => {
			expect(items(query).map((item) => item.title)).toEqual(["retryBudget"]);
		}
	);

	it("scores the row against the braced spelling, so it can be promoted", () => {
		const [row] = items("{{retryBudget}}");
		expect(scoreItem(row, "{{retryBudget}}")).toBeGreaterThanOrEqual(MATCH_FLOOR);
		expect(scoreItem(row, "{{retry")).toBeGreaterThanOrEqual(MATCH_FLOOR);
	});

	it("treats braces with no name in them as an empty query", () => {
		expect(items("{{")).toEqual([]);
		expect(items("}}")).toEqual([]);
		expect(items("{{ }}")).toEqual([]);
	});

	it("still matches an environment name that holds a space", () => {
		expect(items("staging eu").map((item) => item.title)).toEqual(["Staging EU"]);
	});
});
