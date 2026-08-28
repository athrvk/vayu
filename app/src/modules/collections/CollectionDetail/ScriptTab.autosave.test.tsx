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
 * The collection's script tabs save the way its Info tab does, and this is the
 * change (#446).
 *
 * A script is a text buffer, and the two other places you edit one - the request
 * builder's script panels and this screen's own description - both persist it
 * without being asked. These two demanded "Save Script", so the same act on the
 * same kind of field either stuck or did not depending on which pane you were
 * in.
 *
 * What the button was carrying, asserted rather than assumed:
 *
 *   - **the commit**, now the editor losing focus;
 *   - **Clear's write**, which used to be a Clear press followed by a Save press
 *     and now has no later blur to ride on - focus is on the button, not in the
 *     editor.
 *
 * The absence of the Save button is asserted directly: leaving it in place while
 * adding blur-commit would save twice and look entirely fine on screen.
 *
 * The Auth tab deliberately did not move (see `AuthTab.test.tsx`, which pins the
 * other half of the same decision).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

/*
 * The chip row reads the contract and the variables in scope (issue #1075).
 * Nothing here is about chips - this file is the save behaviour - but the tab
 * renders the row either way, and these hooks reach the query layer this file
 * deliberately does not stand up.
 */
vi.mock("@/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks")>()),
	useDataContract: () => undefined,
	useVariableResolver: () => ({ getAllVariables: () => ({}) }),
}));

/*
 * Monaco does not run in jsdom. The stub is a real focusable element inside the
 * editor's container, which is the part under test: the tab listens for
 * `focusout` on the container rather than on Monaco's own blur, so what has to
 * be right is the DOM, and a stub that could not take focus would test nothing.
 */
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
		<textarea
			data-testid="code-editor"
			aria-label="Script"
			value={value}
			onChange={(e) => onChange?.(e.target.value)}
		/>
	),
}));

const { default: ScriptTab } = await import("./ScriptTab");

function makeCollection(script: string): Collection {
	return {
		id: "c1",
		name: "Acme API",
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		preRequestScript: script,
		postRequestScript: script,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

const editor = () => screen.getByTestId("code-editor") as HTMLTextAreaElement;

beforeEach(() => {
	vi.clearAllMocks();
});

describe.each([
	["pre", "preRequestScript"],
	["post", "postRequestScript"],
] as const)("the %s-request script tab saves like the request builder", (kind, field) => {
	it("has no Save button", () => {
		render(<ScriptTab collection={makeCollection("")} kind={kind} />);

		expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
	});

	it("commits when focus leaves the editor", () => {
		render(<ScriptTab collection={makeCollection("")} kind={kind} />);
		fireEvent.change(editor(), { target: { value: "pm.test('ok', () => {});" } });
		fireEvent.blur(editor());

		expect(mutation.mutateAsync).toHaveBeenCalledWith({
			id: "c1",
			[field]: "pm.test('ok', () => {});",
		});
	});

	it("does not save a script that did not change", () => {
		render(<ScriptTab collection={makeCollection("console.log(1);")} kind={kind} />);
		// Tabbing through the panel is not an edit, and `persist` gates on
		// `isDirty` for exactly this.
		fireEvent.blur(editor());

		expect(mutation.mutateAsync).not.toHaveBeenCalled();
	});

	it("ignores focus moving inside the editor", () => {
		// Monaco's find widget takes focus on Ctrl+F without the user having
		// finished anything, and `focusout` bubbles to the container either way -
		// so the handler reads `relatedTarget` rather than trusting the event.
		render(<ScriptTab collection={makeCollection("")} kind={kind} />);
		const field = editor();
		fireEvent.change(field, { target: { value: "pm.test('ok', () => {});" } });

		const sibling = document.createElement("input");
		field.parentElement?.appendChild(sibling);
		fireEvent.blur(field, { relatedTarget: sibling });

		expect(mutation.mutateAsync).not.toHaveBeenCalled();
	});

	it("writes the empty script when Clear is pressed", () => {
		// Clear used to be half a gesture - press Clear, then press Save. With no
		// Save button and focus on Clear rather than in the editor, no blur is
		// coming, so the press has to carry the write itself.
		render(<ScriptTab collection={makeCollection("console.log(1);")} kind={kind} />);
		fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));

		expect(mutation.mutateAsync).toHaveBeenCalledWith({ id: "c1", [field]: "" });
		expect(editor().value).toBe("");
	});
});
