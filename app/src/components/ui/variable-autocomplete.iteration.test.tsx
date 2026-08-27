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
 * `$vu` / `$iteration` in the `{{` picker's own group (issue #994). Same shape
 * as `variable-autocomplete.dynamic.test.tsx` beside it, but a separate group
 * and no shadowing: `variable-resolution.ts` reserves the names ahead of the
 * scope lookup, so a same-named stored variable never wins for these two.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { VariableAutocomplete } from "./variable-autocomplete";
import type { ResolvedVariable } from "@/types";

beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
});

const variable = (value: string): ResolvedVariable =>
	({ value, scope: "global" }) as ResolvedVariable;

describe("$vu / $iteration in the plain-field list", () => {
	it("shows them under their own heading", () => {
		render(<VariableAutocomplete variables={{}} onSelect={vi.fn()} />);
		expect(screen.getByText("Iteration")).toBeInTheDocument();
		expect(screen.getByText("$vu")).toBeInTheDocument();
		expect(screen.getByText("$iteration")).toBeInTheDocument();
	});

	it("is still offered when a stored variable of the same name exists - not shadowed like a generator", () => {
		render(<VariableAutocomplete variables={{ $vu: variable("shadowed") }} onSelect={vi.fn()} />);
		expect(screen.getAllByText("$vu")).toHaveLength(2); // once in Variables, once in Iteration
		expect(screen.getByText("Iteration")).toBeInTheDocument();
	});

	it("filters by the typed query", () => {
		render(<VariableAutocomplete variables={{}} searchQuery="$vu" onSelect={vi.fn()} />);
		expect(screen.getByText("$vu")).toBeInTheDocument();
		expect(screen.queryByText("$iteration")).toBeNull();
	});

	it("selects by name, braces included in the caller's insert", () => {
		const onSelect = vi.fn();
		render(<VariableAutocomplete variables={{}} searchQuery="$iteration" onSelect={onSelect} />);
		screen.getByText("$iteration").click();
		expect(onSelect).toHaveBeenCalledWith("$iteration");
	});
});
