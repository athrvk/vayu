import { describe, it, expect } from "vitest";
import { resolveNewRequestTarget } from "./targetCollection";
import type { Collection } from "@/types";

function collection(id: string): Collection {
	return { id, name: id } as Collection;
}

const many = [collection("c1"), collection("c2"), collection("c3")];

describe("resolveNewRequestTarget", () => {
	it("uses the remembered collection when it still exists", () => {
		expect(resolveNewRequestTarget("c2", many)).toEqual({
			kind: "collection",
			collectionId: "c2",
		});
	});

	it("ignores a remembered collection that was deleted, and asks", () => {
		expect(resolveNewRequestTarget("gone", many)).toEqual({ kind: "pick" });
	});

	it("asks when there is no memory and several collections", () => {
		expect(resolveNewRequestTarget(null, many)).toEqual({ kind: "pick" });
	});

	it("uses the only collection without asking", () => {
		expect(resolveNewRequestTarget(null, [collection("solo")])).toEqual({
			kind: "collection",
			collectionId: "solo",
		});
	});

	it("uses the sole collection even over a stale memory", () => {
		expect(resolveNewRequestTarget("gone", [collection("solo")])).toEqual({
			kind: "collection",
			collectionId: "solo",
		});
	});

	it("creates one when there are no collections", () => {
		expect(resolveNewRequestTarget(null, [])).toEqual({ kind: "create" });
	});
});
