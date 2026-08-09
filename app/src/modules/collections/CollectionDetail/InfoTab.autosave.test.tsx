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
 * Both Info tabs save the same way, and this is the one that changed.
 *
 * The collection's Info tab persisted only through "Save Changes" / "Cancel"
 * while the request builder - the surface the day is spent in - committed on
 * blur. The same act on the same kind of field either stuck or did not
 * depending on which pane you were in, which is a coherence bug rather than two
 * defensible choices.
 *
 * Removing the buttons removes something real, so the two things they were
 * carrying are asserted here rather than assumed:
 *
 *   - **the commit** they used to be the only trigger for, now blur;
 *   - **the blank-name refusal** their disabled state used to express, now
 *     spoken through the save channel with the stored name put back.
 *
 * The absence of the buttons is asserted directly: leaving them in place while
 * adding blur-commit would save twice and look entirely fine on screen.
 *
 * Failed saves keep their existing surface (`SaveFailed`, covered in
 * `InfoTab.markdown.test.tsx`) - a rejected mutation is a different failure
 * from a refused edit, and only the second one is new here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useSaveStore } from "@/stores/save-store";
import type { Collection } from "@/types";

const mutation = {
	mutateAsync: vi.fn(() => Promise.resolve()),
	mutate: vi.fn(),
	reset: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => mutation,
}));

const { default: InfoTab } = await import("./InfoTab");

const collection = {
	id: "c1",
	name: "Acme API",
	description: "Payout endpoints.",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
} as unknown as Collection;

function renderTab() {
	return render(
		<TooltipProvider>
			<InfoTab collection={collection} requestCount={3} />
		</TooltipProvider>
	);
}

/**
 * By its accessible name, not its value: these tests edit before they blur, and
 * `getByDisplayValue` cannot find the field again once the edit has changed what
 * it displays.
 */
const nameField = () => screen.getByLabelText("Collection name") as HTMLInputElement;

beforeEach(() => {
	vi.clearAllMocks();
	useSaveStore.setState({ status: "idle" });
});

describe("the collection Info tab saves like the request builder", () => {
	it("has no Save or Cancel button", () => {
		renderTab();

		expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
	});

	it("commits the name on blur", () => {
		renderTab();
		const field = nameField();
		fireEvent.change(field, { target: { value: "Acme Payouts" } });
		fireEvent.blur(field);

		expect(mutation.mutateAsync).toHaveBeenCalledWith({
			id: "c1",
			name: "Acme Payouts",
			description: "Payout endpoints.",
		});
	});

	it("trims what it commits", () => {
		renderTab();
		const field = nameField();
		fireEvent.change(field, { target: { value: "  Acme Payouts  " } });
		fireEvent.blur(field);

		expect(mutation.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Acme Payouts" })
		);
	});

	it("refuses a blank name, restores the stored one, and says so", () => {
		renderTab();
		const field = nameField();
		fireEvent.change(field, { target: { value: "   " } });
		fireEvent.blur(field);

		expect(mutation.mutateAsync).not.toHaveBeenCalled();
		expect(screen.getByDisplayValue("Acme API")).toBeTruthy();
		// The disabled Save button used to be the whole message. With it gone,
		// silence here would be indistinguishable from a save that worked.
		expect(useSaveStore.getState().status).toBe("error");
	});

	it("does not save a name that did not change", () => {
		renderTab();
		fireEvent.blur(nameField());

		// `canSave` gates on `isDirty`, so a blur that follows no edit - tabbing
		// through the form - must not write.
		expect(mutation.mutateAsync).not.toHaveBeenCalled();
	});
});
