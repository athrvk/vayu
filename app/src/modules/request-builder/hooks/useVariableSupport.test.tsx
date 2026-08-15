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
 * The builder's inputs only paint a `{{data.*}}` token against the contract if
 * the contract actually reaches them (issue #600).
 *
 * This is the wiring half of the feature, and it is the half this codebase
 * keeps losing: `VariableInput` reads `variables.dataColumns`, and every test
 * of the painting hands it a stub, so a `useVariableSupport` that never filled
 * the member would leave every token neutral in the running app with a green
 * suite.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DataContractScope } from "@/types";

const contract: DataContractScope = {
	collectionId: "col-checkout",
	collectionName: "Checkout flow",
	columns: ["id", "email"],
};

/*
 * Stable member identities, as the provider's own `useCallback`s give: the
 * memo below can only be measured against a context that does not hand out
 * fresh functions every render.
 */
const contextValue = {
	request: { collectionId: "col_leaf" },
	resolveString: (s: string) => s,
	getAllVariables: () => ({}),
	getVariableOrigins: () => [],
	updateVariable: () => {},
	writableScopes: [],
	dataColumns: contract,
};

vi.mock("../context/RequestBuilderContext", () => ({
	useRequestBuilderContext: () => contextValue,
}));

const { useVariableSupport } = await import("./useVariableSupport");

describe("useVariableSupport", () => {
	it("carries the contract in scope, so the tokens can be painted against it", () => {
		const { result } = renderHook(() => useVariableSupport());
		expect(result.current.dataColumns).toBe(contract);
	});

	it("keeps its identity across renders, since it is a prop on a memoised row", () => {
		const { result, rerender } = renderHook(() => useVariableSupport());
		const first = result.current;
		rerender();
		expect(result.current).toBe(first);
	});
});
