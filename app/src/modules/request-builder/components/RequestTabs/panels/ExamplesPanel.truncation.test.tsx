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
 * A partial example says so on its row (issue #659 item 2).
 *
 * A mock server answers with a stored example's body verbatim, and nothing on
 * the wire says anything is missing - so an example saved from a capped
 * response is served as though it were a whole one. Until the engine had a
 * column for it, the only disclosure was a " (truncated body)" suffix on the
 * *default name*, and the save dialog invites the user to edit that field: rename
 * it and the row reads as complete forever after.
 *
 * Rendered rather than source-scanned, because the chip arrives from a query
 * result at runtime and a scan cannot see which rows get one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { RequestExample } from "@/types";
import ExamplesPanel from "./ExamplesPanel";

const examples: { value: RequestExample[] } = { value: [] };

vi.mock("@/queries", () => ({
	useRequestExamplesQuery: () => ({
		data: examples.value,
		isLoading: false,
		isError: false,
	}),
	useDeleteRequestExampleMutation: () => ({
		mutate: vi.fn(),
		reset: vi.fn(),
		isPending: false,
		error: null,
	}),
}));

vi.mock("../../../context", () => ({
	useRequestBuilderContext: () => ({ request: { id: "req_1" } }),
}));

function example(overrides: Partial<RequestExample> = {}): RequestExample {
	return {
		id: "exa_1",
		name: "200 OK",
		status: 200,
		headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
		body: '{"id":1}',
		contentType: "application/json",
		// A truncated body can only come from a save: import copies whole ones.
		origin: "user",
		...overrides,
	};
}

beforeEach(() => {
	cleanup();
	examples.value = [];
});

describe("the partial-body chip", () => {
	it("marks a row whose stored body stops short", () => {
		examples.value = [example({ bodyTruncated: true })];
		render(<ExamplesPanel />);

		expect(screen.getByText("Partial body")).toBeTruthy();
	});

	it("says nothing about a complete row", () => {
		// The other half: a chip on every row would carry no information at all.
		examples.value = [example()];
		render(<ExamplesPanel />);

		expect(screen.queryByText("Partial body")).toBeNull();
	});

	it("survives a name that no longer mentions it", () => {
		/*
		 * The defect itself. The old disclosure lived in the name, so this row -
		 * renamed at save time, as the dialog invites - was indistinguishable
		 * from a whole response.
		 */
		examples.value = [example({ name: "Large order list", bodyTruncated: true })];
		render(<ExamplesPanel />);

		expect(screen.getByText("Large order list")).toBeTruthy();
		expect(screen.getByText("Partial body")).toBeTruthy();
	});

	it("marks only the rows that are partial when a request holds both", () => {
		examples.value = [
			example({ id: "exa_1", name: "Whole" }),
			example({ id: "exa_2", name: "Cut", bodyTruncated: true }),
		];
		render(<ExamplesPanel />);

		expect(screen.getAllByText("Partial body")).toHaveLength(1);
	});

	// Amber, never destructive: a partial example is a usable one - the mock
	// will serve it and the bytes are real as far as they go - so the state is
	// "know this", not "broken". The same reading the data-token tones carry.
	it("warns rather than condemns", () => {
		examples.value = [example({ bodyTruncated: true })];
		render(<ExamplesPanel />);

		const chip = screen.getByText("Partial body");
		expect(chip.className).toContain("text-warning-text");
		expect(chip.className).not.toContain("destructive");
	});
});
