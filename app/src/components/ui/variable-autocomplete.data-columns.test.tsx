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
 * actually written. Offered as full `data.<column>` names rather than bare ones
 * because that is the string the token carries, and `onSelect` inserts exactly
 * what it is handed.
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
});
