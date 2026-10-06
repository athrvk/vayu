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
import { SECRET_UI_MASK } from "@/services/codegen";

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
let variables: Record<string, { value: string; scope: string; secret?: boolean }> = {};
const contextValue = {
	request: { collectionId: "col_leaf" },
	resolveString: (s: string) => s,
	getAllVariables: () => variables,
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

	describe("maskSecrets (#1810)", () => {
		it("hides a secret variable's value and leaves a plain one", () => {
			variables = {
				token: { value: "hunter2", scope: "environment", secret: true },
				region: { value: "eu-1", scope: "environment" },
			};
			const { result } = renderHook(() => useVariableSupport());
			expect(result.current.maskSecrets?.("a=hunter2&r=eu-1")).toBe(
				`a=${SECRET_UI_MASK}&r=eu-1`
			);
		});

		it("reads the secrets when it is called, so the memo never holds one", () => {
			variables = {};
			const { result } = renderHook(() => useVariableSupport());
			expect(result.current.maskSecrets?.("hunter2")).toBe("hunter2");

			variables = { token: { value: "hunter2", scope: "environment", secret: true } };
			expect(result.current.maskSecrets?.("hunter2")).toBe(SECRET_UI_MASK);
		});
	});
});
