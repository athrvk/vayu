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
 * The request's name is editable from the tab that calls itself Info.
 *
 * It used to be editable only from the sidebar row's rename (F2 or the row
 * menu) and visible only in the tab strip - so the panel documenting a request
 * had nothing to say about what the request was called, and a user working in
 * the builder had to go back to the tree to fix a name.
 *
 * The rule the field has to hold is that a request keeps a name. Losing the
 * Save button to autosave means losing the disabled state that used to express
 * that, so a blank one is refused *out loud*: the stored name comes back and
 * the save channel says why. Silence would look identical to a save that
 * worked, which is the failure this repo hits most.
 *
 * Written as its own file rather than folded into `info-tab.test.tsx`, which
 * mocks this panel away to guard the tab *order* - unmocking it there would
 * drag Monaco into a test about which tab comes first.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import { useSaveStore } from "@/stores/save-store";

// The description half is a Monaco-backed markdown editor and is covered by its
// own tests; the name field is a plain input and is what this is about.
vi.mock("@/components/ui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/components/ui")>();
	return { ...actual, MarkdownEditor: () => null };
});

const { default: InfoPanel } = await import("./InfoPanel");

const updateField = vi.fn();
const restoreStoredName = vi.fn();
const saveRequest = vi.fn(() => Promise.resolve());

function renderPanel(name: string) {
	const value = {
		request: { ...createDefaultRequestState(), name },
		updateField,
		restoreStoredName,
		saveRequest,
		saveStatus: "idle",
	} as unknown as RequestBuilderContextValue;

	return render(
		<RequestBuilderContext.Provider value={value}>
			<InfoPanel />
		</RequestBuilderContext.Provider>
	);
}

const nameField = () => screen.getByLabelText("Request name") as HTMLInputElement;

beforeEach(() => {
	vi.clearAllMocks();
	useSaveStore.setState({ status: "idle" });
});

describe("the request Info tab's name field", () => {
	it("shows the request's name", () => {
		renderPanel("List settlements");

		expect(nameField().value).toBe("List settlements");
	});

	it("persists on blur, without a Save button", () => {
		renderPanel("List settlements");
		fireEvent.change(nameField(), { target: { value: "List payouts" } });
		fireEvent.blur(nameField());

		expect(updateField).toHaveBeenCalledWith("name", "List payouts");
		expect(saveRequest).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
	});

	it("trims what it saves", () => {
		renderPanel("  List payouts  ");
		fireEvent.blur(nameField());

		// Untrimmed, this is a different name from "List payouts" in every list
		// that shows it.
		expect(updateField).toHaveBeenCalledWith("name", "List payouts");
		expect(saveRequest).toHaveBeenCalledTimes(1);
	});

	it("refuses a blank name, restores the stored one, and says so", () => {
		renderPanel("   ");
		fireEvent.blur(nameField());

		expect(restoreStoredName).toHaveBeenCalledTimes(1);
		// Refused, not saved: a save here would carry the blank to the engine, and
		// the payload dropping it would make the refusal silent instead.
		expect(saveRequest).not.toHaveBeenCalled();
		expect(useSaveStore.getState().status).toBe("error");
	});
});
