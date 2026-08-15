/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The chain rule and the three token states (issue #600).
 *
 * The chain rule is the part that is easy to get subtly wrong and impossible to
 * see in a screenshot: a request in a sub-collection binds the *parent's* data
 * when the sub-collection declares none, so the contract that validates its
 * tokens has to be the parent's too. A painter that read only the leaf's row
 * would paint every token in a sub-collection amber.
 */

import { describe, it, expect } from "vitest";
import {
	collectionsUnderContract,
	describeDataToken,
	resolveDataContract,
	type ContractNode,
} from "./data-contract";

function collection(
	id: string,
	parentId?: string,
	columns?: string[],
	name = `collection-${id}`
): ContractNode {
	return { id, parentId, name, dataSchema: columns ? { columns } : {} };
}

describe("resolveDataContract", () => {
	it("finds the leaf's own contract", () => {
		const contract = resolveDataContract("leaf", [collection("leaf", undefined, ["id"])]);
		expect(contract).toEqual({ collectionName: "collection-leaf", columns: ["id"] });
	});

	it("walks up to the nearest declaring ancestor when the leaf declares none", () => {
		const contract = resolveDataContract("leaf", [
			collection("root", undefined, ["id", "email"]),
			collection("mid", "root"),
			collection("leaf", "mid"),
		]);
		expect(contract?.collectionName).toBe("collection-root");
		expect(contract?.columns).toEqual(["id", "email"]);
	});

	it("stops at the nearest one - leaf beats root", () => {
		// The variable chain's own rule (leaf over root). A parent contract
		// winning here would let an ancestor's stale columns invalidate a
		// sub-collection that has since declared its own.
		const contract = resolveDataContract("leaf", [
			collection("root", undefined, ["id"]),
			collection("leaf", "root", ["plan"]),
		]);
		expect(contract?.collectionName).toBe("collection-leaf");
		expect(contract?.columns).toEqual(["plan"]);
	});

	it("treats a declared-then-cleared collection as transparent, not as a contract of none", () => {
		// Clearing stores `{}`, which is how "no contract" is spelled. Reading it
		// as an override would let it shadow a working contract above.
		const contract = resolveDataContract("leaf", [
			collection("root", undefined, ["id"]),
			{ id: "leaf", parentId: "root", name: "leaf", dataSchema: { columns: [] } },
		]);
		expect(contract?.collectionName).toBe("collection-root");
	});

	it("is null when nothing in the chain declares one, and for no collection at all", () => {
		expect(resolveDataContract("leaf", [collection("leaf")])).toBeNull();
		expect(resolveDataContract(undefined, [collection("leaf", undefined, ["id"])])).toBeNull();
	});

	it("terminates on a parentId cycle", () => {
		// The engine tolerates cycles in stored data, so an unguarded walk here
		// is a hung window rather than a wrong answer.
		const nodes = [collection("a", "b"), collection("b", "a", ["id"])];
		expect(resolveDataContract("a", nodes)?.columns).toEqual(["id"]);
	});
});

describe("collectionsUnderContract", () => {
	const tree = [
		collection("root", undefined, ["id"]),
		collection("child", "root"),
		collection("grandchild", "child"),
		collection("owner", "root", ["other"]),
		collection("under-owner", "owner"),
		collection("elsewhere", undefined, ["id"]),
	];

	it("covers the whole subtree the contract binds", () => {
		expect(collectionsUnderContract("root", tree)).toEqual(["root", "child", "grandchild"]);
	});

	it("stops at a sub-collection that declares its own, and its subtree with it", () => {
		// `owner` answers for itself and for `under-owner` (the chain rule), so
		// neither belongs in the root contract's audit.
		const ids = collectionsUnderContract("root", tree);
		expect(ids).not.toContain("owner");
		expect(ids).not.toContain("under-owner");
	});
});

describe("describeDataToken", () => {
	const contract = {
		collectionName: "Users",
		columns: ["id", "email", "plan"],
	};

	it("says nothing new when no contract is in scope - phase 1's state, unchanged", () => {
		const described = describeDataToken("data.email", null);
		expect(described.tone).toBe("muted");
		expect(described.description).toBe("Bound by the run's data file");
	});

	it("names the declaring collection for a declared column", () => {
		const described = describeDataToken("data.email", contract);
		expect(described.tone).toBe("muted");
		expect(described.description).toBe("Data column - bound per iteration");
		expect(described.note).toContain("Users");
	});

	it("warns, and prints the declared list, for a column the contract does not carry", () => {
		const described = describeDataToken("data.emial", contract);
		expect(described.tone).toBe("warning");
		expect(described.description).toContain("Users");
		expect(described.note).toBe("declared: id, email, plan");
	});

	it("leaves a name outside the namespace in the neutral state", () => {
		// `{{data.}}` addresses no column, so it is not the namespace's business -
		// the boundary `isDataVariableName` draws.
		expect(describeDataToken("data.", contract).tone).toBe("muted");
	});
});
