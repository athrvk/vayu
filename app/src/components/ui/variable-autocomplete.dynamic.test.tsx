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
 * The `{{` list in a plain field is the other half of discoverability - the
 * Monaco provider covers body editors, this covers the URL bar, header values
 * and every key/value cell. Same rules as there: dynamic variables are a
 * separate group so they cannot bury a workspace's own names, and one that a
 * real variable shadows is not offered, because the generator would not run.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { VariableAutocomplete } from "./variable-autocomplete";
import type { ResolvedVariable } from "@/types";

// cmdk scrolls its selected item into view on mount; jsdom has no layout and no
// such method. Same stub CollectionTree's reveal test uses.
beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
});

const variable = (value: string): ResolvedVariable =>
	({ value, scope: "global" }) as ResolvedVariable;

describe("dynamic variables in the plain-field list", () => {
	it("shows them under their own heading, with the stored ones above", () => {
		render(
			<VariableAutocomplete
				variables={{ baseUrl: variable("https://api.test") }}
				onSelect={vi.fn()}
			/>
		);
		expect(screen.getByText("Variables")).toBeInTheDocument();
		expect(screen.getByText("Dynamic")).toBeInTheDocument();
		expect(screen.getByText("baseUrl")).toBeInTheDocument();
		expect(screen.getByText("$guid")).toBeInTheDocument();
		// The description is what says the value is made rather than stored.
		expect(screen.getAllByText("UUID v4").length).toBeGreaterThan(0);
	});

	it("filters them by the typed query", () => {
		render(<VariableAutocomplete variables={{}} searchQuery="$random" onSelect={vi.fn()} />);
		expect(screen.getByText("$randomEmail")).toBeInTheDocument();
		expect(screen.queryByText("$guid")).toBeNull();
	});

	it("renders the list for a workspace with no variables of its own", () => {
		// It used to return null on an empty map, which would have hidden the
		// generators from exactly the new workspace that needs them most.
		render(<VariableAutocomplete variables={{}} onSelect={vi.fn()} />);
		expect(screen.getByText("$timestamp")).toBeInTheDocument();
		expect(screen.queryByText("Variables")).toBeNull();
	});

	it("drops a generator a real variable shadows", () => {
		render(
			<VariableAutocomplete variables={{ $guid: variable("pinned") }} onSelect={vi.fn()} />
		);
		expect(screen.getAllByText("$guid")).toHaveLength(1);
		expect(screen.queryByText("Dynamic")).toBeInTheDocument();
	});

	it("selects by name, braces included in the caller's insert", () => {
		const onSelect = vi.fn();
		render(<VariableAutocomplete variables={{}} searchQuery="$guid" onSelect={onSelect} />);
		screen.getByText("$guid").click();
		expect(onSelect).toHaveBeenCalledWith("$guid");
	});
});
