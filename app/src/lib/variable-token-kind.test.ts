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
import { classifyVariableToken } from "./variable-token-kind";
import type { DataContractScope, ResolvedVariable } from "@/types";

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
