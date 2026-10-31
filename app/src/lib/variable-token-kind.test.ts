/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The order is the feature.
 *
 * Every case here is one rung of the ladder `resolveTemplate` climbs, and each
 * is a bug the overlay strip has already had to fix once: a variable someone
 * named `data.email` answering for a column, a generator shadowed by a real
 * variable (or not), a bare column painted red as undefined. The Monaco editors
 * now read this same decision, so a rung that slips here slips in two surfaces.
 */

import { describe, it, expect } from "vitest";
import { classifyScriptToken, classifyVariableToken } from "./variable-token-kind";
import { describeBareColumnToken, describeDataToken } from "./data-contract";
import type { DataContractScope, ResolvedVariable, VariableOrigin } from "@/types";

const contract: DataContractScope = {
	collectionId: "c1",
	collectionName: "Checkout",
	columns: ["email", "plan"],
};

function variable(value: string, extra: Partial<ResolvedVariable> = {}): ResolvedVariable {
	return { value, scope: "environment", ...extra };
}

describe("classifyVariableToken", () => {
	it("reads the data namespace before the scopes", () => {
		const kind = classifyVariableToken("data.email", {
			// A variable of the very same name, which must not answer for it.
			variables: { "data.email": variable("from-the-environment") },
			dataColumns: contract,
		});
		expect(kind.state).toBe("runtime");
		if (kind.state !== "runtime") return;
		expect(kind.tone).toBe("muted");
		expect(kind.note).toContain("Checkout");
	});

	it("warns about a column no contract in scope declares", () => {
		const kind = classifyVariableToken("data.nope", { variables: {}, dataColumns: contract });
		expect(kind.state).toBe("runtime");
		if (kind.state !== "runtime") return;
		expect(kind.tone).toBe("warning");
		expect(kind.description).toContain("Checkout");
	});

	it("reads the identity namespace before the scopes too", () => {
		const kind = classifyVariableToken("$vu", {
			variables: { $vu: variable("7") },
			dataColumns: null,
		});
		expect(kind.state).toBe("runtime");
		if (kind.state !== "runtime") return;
		expect(kind.note).toBe("not generated here");
	});

	it("treats a bare declared column as bound by the row, not as undefined", () => {
		const kind = classifyVariableToken("email", { variables: {}, dataColumns: contract });
		expect(kind.state).toBe("runtime");
	});

	it("leaves a bare column alone when a scope defines the name", () => {
		const kind = classifyVariableToken("email", {
			variables: { email: variable("me@example.com") },
			dataColumns: contract,
		});
		expect(kind.state).toBe("resolved");
	});

	it("offers a generator only where nothing defines the name", () => {
		expect(classifyVariableToken("$guid", { variables: {} }).state).toBe("runtime");
		expect(
			classifyVariableToken("$guid", { variables: { $guid: variable("pinned") } }).state
		).toBe("resolved");
	});

	it("separates a resolved value from an empty one", () => {
		expect(
			classifyVariableToken("baseUrl", { variables: { baseUrl: variable("") } }).state
		).toBe("empty");
		expect(
			classifyVariableToken("baseUrl", { variables: { baseUrl: variable("https://x") } })
				.state
		).toBe("resolved");
	});

	it("carries the winning definition through, so the popover can edit it", () => {
		const kind = classifyVariableToken("token", {
			variables: { token: variable("abc", { secret: true, sourceName: "Staging" }) },
		});
		expect(kind.state).toBe("resolved");
		if (kind.state === "runtime") return;
		expect(kind.info?.secret).toBe(true);
		expect(kind.info?.sourceName).toBe("Staging");
	});

	it("is undefined when nothing anywhere answers the name", () => {
		const kind = classifyVariableToken("missing", { variables: {}, dataColumns: contract });
		expect(kind.state).toBe("undefined");
		if (kind.state === "runtime") return;
		expect(kind.info).toBeNull();
	});
});

describe("a name the engine defers (#2741)", () => {
	const deferredVariables = ["token"];

	it.each([
		["a stored value", variable("abc")],
		["an empty value", variable("")],
		["no definition", null],
	])("outranks resolved, empty and undefined: %s", (_label, stored) => {
		const kind = classifyVariableToken("token", {
			variables: stored ? { token: stored } : {},
			deferredVariables,
		});
		expect(kind.state).toBe("deferred");
		if (kind.state === "runtime") return;
		// The stored definition rides along so the popover can still edit it.
		expect(kind.info).toEqual(stored);
	});

	it("paints only the names listed", () => {
		const context = { variables: { token: variable("abc"), host: variable("h") } };
		expect(classifyVariableToken("host", { ...context, deferredVariables }).state).toBe(
			"resolved"
		);
	});

	it.each([undefined, []])("changes nothing when the list is %j", (list) => {
		const kind = classifyVariableToken("token", {
			variables: { token: variable("abc") },
			deferredVariables: list,
		});
		expect(kind.state).toBe("resolved");
	});

	it("leaves the reserved namespaces to their own rungs", () => {
		const kind = classifyVariableToken("$vu", { variables: {}, deferredVariables: ["$vu"] });
		expect(kind.state).toBe("runtime");
	});

	it("never reaches a script's own reads: the pre-request script is what sets the name", () => {
		const context = {
			variables: { token: variable("abc") },
			getVariableOrigins: () => [
				{ scope: "environment" as const, value: "abc", enabled: true, winner: true },
			],
			deferredVariables,
		};
		// The body-language read is deferred; the merged, scoped and row reads of a script are not.
		expect(classifyScriptToken("token", undefined, context).state).toBe("deferred");
		expect(classifyScriptToken("token", { via: "merged" }, context).state).toBe("resolved");
		expect(
			classifyScriptToken("token", { via: "scope", scope: "environment" }, context).state
		).toBe("resolved");
		expect(classifyScriptToken("token", { via: "bare" }, context).state).toBe("runtime");
	});
});

describe("classifyScriptToken", () => {
	it("falls through to the merged ladder with no hint - a body-language token", () => {
		const kind = classifyScriptToken("baseUrl", undefined, {
			variables: { baseUrl: { value: "https://x", scope: "environment" } },
		});
		expect(kind.state).toBe("resolved");
	});

	it("reads the same ladder for a merged read - pm.variables.get and replaceIn", () => {
		const kind = classifyScriptToken(
			"baseUrl",
			{ via: "merged" },
			{ variables: { baseUrl: { value: "https://x", scope: "environment" } } }
		);
		expect(kind.state).toBe("resolved");
	});

	it("answers a single scope's own read, not the ladder's winner", () => {
		const origins: VariableOrigin[] = [
			{ scope: "global", value: "https://old", enabled: true, winner: false },
			{
				scope: "environment",
				value: "https://api.example.com",
				enabled: true,
				winner: true,
			},
		];
		// pm.collectionVariables.get - nothing at collection scope, even though
		// the environment (which wins the whole ladder) defines it.
		const kind = classifyScriptToken(
			"baseUrl",
			{ via: "scope", scope: "collection" },
			{ variables: {}, getVariableOrigins: () => origins }
		);
		expect(kind.state).toBe("undefined");
	});

	it("resolves from the accessor's own scope when that scope defines it", () => {
		const origins: VariableOrigin[] = [
			{ scope: "global", value: "https://old", enabled: true, winner: false },
		];
		const kind = classifyScriptToken(
			"baseUrl",
			{ via: "scope", scope: "global" },
			{ variables: {}, getVariableOrigins: () => origins }
		);
		expect(kind.state).toBe("resolved");
		if (kind.state === "runtime") return;
		expect(kind.info?.value).toBe("https://old");
	});

	it("separates empty from undefined for a single-scope read too", () => {
		const origins: VariableOrigin[] = [
			{ scope: "global", value: "", enabled: true, winner: true },
		];
		const kind = classifyScriptToken(
			"token",
			{ via: "scope", scope: "global" },
			{ variables: {}, getVariableOrigins: () => origins }
		);
		expect(kind.state).toBe("empty");
	});

	it("a bound row's column answers pm.iterationData.get, not the scopes", () => {
		const kind = classifyScriptToken(
			"email",
			{ via: "row" },
			{ variables: {}, dataColumns: contract }
		);
		expect(kind.state).toBe("runtime");
		if (kind.state !== "runtime") return;
		expect(kind.note).toContain("Checkout");
	});

	describe("a scoped replaceIn template", () => {
		const scoped = { via: "scope", scope: "environment", template: true } as const;
		const getVariableOrigins = (name: string): VariableOrigin[] =>
			name === "defined"
				? [{ scope: "environment", value: "v", enabled: true, winner: true }]
				: [];

		it("paints a bare declared column as the column - the engine binds it from the row", () => {
			const kind = classifyScriptToken("email", scoped, {
				variables: {},
				dataColumns: contract,
				getVariableOrigins,
			});
			expect(kind).toEqual({
				state: "runtime",
				...describeBareColumnToken(contract),
			});
		});

		it("leaves the same name undefined for a get, which never reads the row", () => {
			const kind = classifyScriptToken(
				"email",
				{ via: "scope", scope: "environment" },
				{ variables: {}, dataColumns: contract, getVariableOrigins }
			);
			expect(kind.state).toBe("undefined");
		});

		it("leaves a name that is neither defined in the scope nor a column undefined", () => {
			const kind = classifyScriptToken("nope", scoped, {
				variables: {},
				dataColumns: contract,
				getVariableOrigins,
			});
			expect(kind.state).toBe("undefined");
		});

		it("keeps the scope's own definition of a name when the scope has one", () => {
			const kind = classifyScriptToken("defined", scoped, {
				variables: {},
				getVariableOrigins,
			});
			expect(kind.state).toBe("resolved");
		});

		it("paints a generator as generated where the scope does not define it", () => {
			const kind = classifyScriptToken("$guid", scoped, {
				variables: {},
				getVariableOrigins,
			});
			expect(kind.state).toBe("runtime");
			if (kind.state !== "runtime") return;
			expect(kind.note).toBe("generated per use");
		});

		it("lets the scope's own definition of a generator name win", () => {
			const kind = classifyScriptToken("$guid", scoped, {
				variables: {},
				getVariableOrigins: () => [
					{ scope: "environment", value: "pinned", enabled: true, winner: true },
				],
			});
			expect(kind.state).toBe("resolved");
		});

		it("does not let another scope's definition of a generator name hide the generator", () => {
			// The merged ladder holds a global `$guid`; this call reads the environment alone.
			const kind = classifyScriptToken("$guid", scoped, {
				variables: { $guid: variable("pinned", { scope: "global" }) },
				getVariableOrigins: () => [
					{ scope: "global", value: "pinned", enabled: true, winner: true },
				],
			});
			expect(kind.state).toBe("runtime");
		});

		it("reads data.* and the iteration identity ahead of a scope variable of the same name", () => {
			const shadowing = (): VariableOrigin[] => [
				{ scope: "environment", value: "x", enabled: true, winner: true },
			];
			const data = classifyScriptToken("data.email", scoped, {
				variables: {},
				dataColumns: contract,
				getVariableOrigins: shadowing,
			});
			expect(data).toEqual({
				state: "runtime",
				...describeDataToken("data.email", contract),
			});
			const identity = classifyScriptToken("$vu", scoped, {
				variables: {},
				getVariableOrigins: shadowing,
			});
			expect(identity.state).toBe("runtime");
			if (identity.state !== "runtime") return;
			expect(identity.note).toBe("not generated here");
		});
	});

	it("a bare script template is always muted and informational, whatever the name resolves to", () => {
		const kind = classifyScriptToken(
			"baseUrl",
			{ via: "bare" },
			{ variables: { baseUrl: { value: "https://x", scope: "environment" } } }
		);
		expect(kind.state).toBe("runtime");
		if (kind.state !== "runtime") return;
		expect(kind.tone).toBe("muted");
		expect(kind.description).toMatch(/not interpolated/i);
		expect(kind.note).toContain("pm.variables.replaceIn");
		// A scoped call interpolates too, so the hint must not send the reader to
		// the merged form alone.
		for (const accessor of ["pm.environment", "pm.globals", "pm.collectionVariables"]) {
			expect(kind.note).toContain(accessor);
		}
	});
});
