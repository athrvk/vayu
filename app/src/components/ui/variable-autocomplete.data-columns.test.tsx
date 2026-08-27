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
 * Declared columns in the plain-field `{{` list (issue #600).
 *
 * The Monaco provider covers the body editors; this list is the URL bar, header
 * values and every key/value cell - which is where most `{{data.*}}` tokens are
 * actually written. Offered as full `data.<column>` names, the string the token
 * carries, and `onSelect` inserts exactly what it is handed.
 *
 * **Each column is offered bare too** (issue #1007): a bound row answers
 * `{{username}}` exactly as it answers `{{data.username}}`, and an imported
 * Postman collection is already written the bare way. The two entries are
 * labeled so picking one is deliberate - see `variable-autocomplete.tsx`.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { VariableAutocomplete } from "./variable-autocomplete";
import type { DataContractScope } from "@/types";

// cmdk scrolls its selected item into view on mount; jsdom has no layout.
beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
});

const contract: DataContractScope = {
	collectionId: "col-checkout",
	collectionName: "Checkout flow",
	columns: ["id", "email"],
};

describe("data columns in the plain-field list", () => {
	it("shows them under their own heading, naming the collection that declared them", () => {
		render(<VariableAutocomplete variables={{}} onSelect={vi.fn()} dataColumns={contract} />);
		expect(screen.getByText("Data columns")).toBeInTheDocument();
		expect(screen.getByText("data.email")).toBeInTheDocument();
		expect(screen.getAllByText("Checkout flow").length).toBeGreaterThan(0);
	});

	it("filters on the whole token name, which is what has been typed", () => {
		// The query at the moment this list matters is `data.`, not `email`.
		render(
			<VariableAutocomplete
				variables={{}}
				searchQuery="data."
				onSelect={vi.fn()}
				dataColumns={contract}
			/>
		);
		expect(screen.getByText("data.id")).toBeInTheDocument();
		expect(screen.queryByText("$guid")).toBeNull();
	});

	it("shows no heading at all when the chain declares no contract", () => {
		render(<VariableAutocomplete variables={{}} onSelect={vi.fn()} />);
		expect(screen.queryByText("Data columns")).toBeNull();
	});

	/*
	 * Bare column names (issue #1007): Postman writes `{{email}}`, not
	 * `{{data.email}}`, so a list that offered only the prefixed spelling would
	 * never suggest the token half the imported collections actually use.
	 */
	describe("the bare spelling, alongside the prefixed one", () => {
		it("offers both spellings under the same heading", () => {
			render(
				<VariableAutocomplete variables={{}} onSelect={vi.fn()} dataColumns={contract} />
			);
			expect(screen.getByText("data.email")).toBeInTheDocument();
			expect(screen.getByText("email")).toBeInTheDocument();
		});

		it("inserts the bare token as the caller receives it, unprefixed", () => {
			const onSelect = vi.fn();
			render(
				<VariableAutocomplete variables={{}} onSelect={onSelect} dataColumns={contract} />
			);
			screen.getByText("email").click();
			expect(onSelect).toHaveBeenCalledWith("email");
		});

		it("labels the bare entry so it reads differently from the prefixed one", () => {
			render(
				<VariableAutocomplete variables={{}} onSelect={vi.fn()} dataColumns={contract} />
			);
			// Both entries name the same collection; only the bare one also says so.
			expect(screen.getAllByText(/bare/).length).toBeGreaterThan(0);
		});

		it("filters the bare spelling on its own name, not the prefixed one", () => {
			// Typing `email` (not `data.email`) is exactly the Postman-muscle-memory
			// case the bare spelling exists for - it must not require the prefix to
			// find itself.
			render(
				<VariableAutocomplete
					variables={{}}
					searchQuery="email"
					onSelect={vi.fn()}
					dataColumns={contract}
				/>
			);
			expect(screen.getByText("email")).toBeInTheDocument();
			expect(screen.getByText("data.email")).toBeInTheDocument();
			expect(screen.queryByText("data.id")).toBeNull();
			expect(screen.queryByText("id")).toBeNull();
		});
	});
});
