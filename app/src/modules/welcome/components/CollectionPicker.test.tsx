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
 * #1881: the picker listed only collection names, so "Payments / Users" and
 * "Admin / Users" were the same row twice and the user chose between them blind.
 *
 * Mutation check: delete the `parentPath` line from `CollectionPicker` and the
 * path assertions fail; the names alone cannot tell the two "Users" apart.
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CollectionPicker } from "./CollectionPicker";
import type { Collection } from "@/types";

function collection(id: string, name: string, parentId?: string): Collection {
	return {
		id,
		name,
		...(parentId ? { parentId } : {}),
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements: [],
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	};
}

const collections = [
	collection("pay", "Payments"),
	collection("adm", "Admin"),
	collection("pay-users", "Users", "pay"),
	collection("adm-users", "Users", "adm"),
	collection("adm-users-roles", "Roles", "adm-users"),
];

function renderPicker(onSelect = vi.fn()) {
	render(
		<CollectionPicker
			open
			onOpenChange={() => {}}
			collections={collections}
			onSelect={onSelect}
		/>
	);
	return onSelect;
}

/** The row's button, found by the one thing both "Users" rows share. */
const usersRows = () =>
	screen.getAllByRole("button").filter((b) => b.textContent?.startsWith("Users"));

describe("CollectionPicker", () => {
	it("gives each same-named collection its own parent path", () => {
		renderPicker();

		const [first, second] = usersRows();
		expect(within(first).getByText("Payments")).toBeInTheDocument();
		expect(within(second).getByText("Admin")).toBeInTheDocument();
		expect(first.textContent).not.toBe(second.textContent);
	});

	it("shows the whole chain above a deeper collection, not just the parent", () => {
		renderPicker();

		const roles = screen.getByRole("button", { name: /^Roles/ });
		expect(within(roles).getByText("Admin / Users")).toBeInTheDocument();
	});

	it("shows no path under a root collection", () => {
		renderPicker();

		const root = screen.getByRole("button", { name: "Payments" });
		expect(root.textContent).toBe("Payments");
	});

	it("still selects by id", () => {
		const onSelect = renderPicker();

		fireEvent.click(usersRows()[1]);

		expect(onSelect).toHaveBeenCalledWith("adm-users");
	});
});
