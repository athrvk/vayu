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
 * The banner naming a field the user is editing that an external write has
 * changed to a different value (issue #1436).
 *
 * One callout per logical group, not per `RequestState` key: the four fields
 * the editor splits a request's body across are one thing to a user, and
 * `takeExternalField` has to be called for every field in a group at once so
 * "Take theirs" resolves the whole conflict, not a quarter of it.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RequestBuilderContext } from "../context";
import type { RequestBuilderContextValue, RequestFieldConflicts } from "../types";

const { default: ExternalChangeNotice } = await import("./ExternalChangeNotice");

function renderWith(fieldConflicts: RequestFieldConflicts, takeExternalField = vi.fn()) {
	const value = { fieldConflicts, takeExternalField } as unknown as RequestBuilderContextValue;
	return {
		takeExternalField,
		...render(
			<RequestBuilderContext.Provider value={value}>
				<ExternalChangeNotice />
			</RequestBuilderContext.Provider>
		),
	};
}

describe("ExternalChangeNotice", () => {
	it("renders nothing when there are no conflicts", () => {
		const { container } = renderWith({});
		expect(container).toBeEmptyDOMElement();
	});

	it("names a single conflicted field", () => {
		renderWith({ url: "https://api.test/agent" });
		expect(screen.getByText(/changed elsewhere: url/i)).toBeTruthy();
	});

	it("groups the four body-shaping fields into one callout", () => {
		renderWith({ bodyMode: "json", body: '{"a":1}' });
		const callouts = screen.getAllByText(/changed elsewhere:/i);
		expect(callouts).toHaveLength(1);
		expect(screen.getByText(/changed elsewhere: body/i)).toBeTruthy();
	});

	it("shows one callout per group when unrelated fields conflict", () => {
		renderWith({ url: "https://api.test/agent", auth: { mode: "none" } });
		expect(screen.getByText(/changed elsewhere: url/i)).toBeTruthy();
		expect(screen.getByText(/changed elsewhere: auth/i)).toBeTruthy();
	});

	it('resolves every field in a group on one "Take theirs" click', () => {
		// Only two of the group's four keys are present - `in` checks key
		// presence, so a key set to `[]` would count as a conflict too.
		const { takeExternalField } = renderWith({ bodyMode: "json", body: '{"a":1}' });

		screen.getByRole("button", { name: /take theirs/i }).click();

		expect(takeExternalField).toHaveBeenCalledWith("bodyMode");
		expect(takeExternalField).toHaveBeenCalledWith("body");
		// The group lists all four body fields, but only the two actually
		// present in `fieldConflicts` are real conflicts to resolve.
		expect(takeExternalField).not.toHaveBeenCalledWith("formData");
		expect(takeExternalField).not.toHaveBeenCalledWith("urlEncoded");
		expect(takeExternalField).toHaveBeenCalledTimes(2);
	});
});
