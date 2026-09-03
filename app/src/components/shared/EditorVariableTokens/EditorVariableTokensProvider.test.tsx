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
 * One popover, opened over a token an editor measured.
 *
 * The point of these cases is that it is the *shared* control: the name, the
 * value, the origins and the writer all arrive from `VariableSupport`, so a fix
 * that lands in `VariablePopover` reaches the editors too. They also pin the two
 * halves an editor cannot check for itself - that closing hands focus back, and
 * that a class of token with nothing behind it never opens at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { VariableSupport } from "@/types";
import { EditorVariableTokensProvider } from "./EditorVariableTokensProvider";
import { useEditorVariableTokensContext, type EditorVariableTokensValue } from "./context";

const updateVariable = vi.fn();

const support: VariableSupport = {
	resolveString: (input) => input,
	getAllVariables: () => ({
		baseUrl: { value: "https://api.example.com", scope: "environment", sourceName: "Staging" },
		token: { value: "s3cr3t", scope: "environment", secret: true },
		email: { value: "ada@example.com", scope: "environment", sourceName: "Staging" },
	}),
	getVariableOrigins: (name) => {
		if (name === "baseUrl") {
			return [
				{ scope: "global", value: "https://old", enabled: true, winner: false },
				{
					scope: "environment",
					sourceName: "Staging",
					value: "https://api.example.com",
					enabled: true,
					winner: true,
				},
			];
		}
		// A picked row's column, which outranks every scope (D18, issue #1007).
		if (name === "email") {
			return [
				{ scope: "row", value: "grace@example.com", enabled: true, winner: true },
				{
					scope: "environment",
					sourceName: "Staging",
					value: "ada@example.com",
					enabled: true,
					winner: false,
				},
			];
		}
		return [];
	},
	updateVariable,
	writableScopes: ["environment", "global"],
};

vi.mock("@/modules/request-builder/hooks/useVariableSupport", () => ({
	useVariableSupport: () => support,
}));

/** Renders the provider and hands back the context an editor would hold. */
function mountProvider() {
	let value: EditorVariableTokensValue | null = null;
	function Probe() {
		value = useEditorVariableTokensContext();
		return null;
	}
	// The app mounts one `TooltipProvider` at the root (`main.tsx`), and the
	// popover's secret-reveal button is a `TooltipIconButton` that needs it.
	render(
		<TooltipProvider>
			<EditorVariableTokensProvider>
				<Probe />
			</EditorVariableTokensProvider>
		</TooltipProvider>
	);
	if (!value) throw new Error("no provider value");
	return value as EditorVariableTokensValue;
}

const rect = { left: 40, top: 24, width: 80, height: 18 };

/**
 * What the tooltip card is saying.
 *
 * Text rather than elements: Radix draws a second, visually hidden copy of the
 * content inside the card for screen readers, so every `getByText` in here
 * would find two of everything. The *shape* of a value and its hint is
 * `TooltipValue`'s to keep, and is pinned where the class can be read off a
 * rendered element (`VariableInput/EditableVariable.test.tsx`).
 */
function cardText(): string {
	const found = document.querySelector('[data-slot="tooltip-content"]');
	if (!found) throw new Error("no tooltip on screen");
	return found.textContent ?? "";
}

beforeEach(() => {
	updateVariable.mockClear();
});

describe("EditorVariableTokensProvider", () => {
	it("opens the shared popover over the token, with its value and the definitions that lost", () => {
		const tokens = mountProvider();
		act(() => tokens.openTokenEditor({ name: "baseUrl", rect }));

		expect(screen.getByText("baseUrl")).toBeTruthy();
		expect(screen.getByDisplayValue("https://api.example.com")).toBeTruthy();
		// The shadowed definition, from the same origins list the tooltip reads.
		expect(screen.getByText(/https:\/\/old/)).toBeTruthy();
	});

	it("keeps a secret masked until it is revealed", () => {
		const tokens = mountProvider();
		act(() => tokens.openTokenEditor({ name: "token", rect }));
		expect(screen.queryByDisplayValue("s3cr3t")).toBeNull();
	});

	it("offers to create a name nothing defines, in a writable scope", () => {
		const tokens = mountProvider();
		act(() => tokens.openTokenEditor({ name: "missing", rect }));
		expect(screen.getByRole("button", { name: /create/i })).toBeTruthy();
	});

	it("opens nothing for a run-time token", () => {
		const tokens = mountProvider();
		act(() => tokens.openTokenEditor({ name: "$guid", rect }));
		expect(screen.queryByText("$guid")).toBeNull();
	});

	it("tells the editor when it closes, so focus goes back where it came from", () => {
		const tokens = mountProvider();
		const onClose = vi.fn();
		act(() => tokens.openTokenEditor({ name: "baseUrl", rect, onClose }));

		fireEvent.keyDown(screen.getByDisplayValue("https://api.example.com"), { key: "Escape" });
		expect(onClose).toHaveBeenCalled();
	});

	/**
	 * The hover card, which replaced Monaco's own hover widget (issue #1320).
	 *
	 * What it says has to be what a `{{token}}` in the URL bar says, because it
	 * is one token read two ways - so these mirror `EditableVariable.test.tsx`
	 * case for case: the value and its source, `secret` and never the secret,
	 * `not defined`, a generator's description, and a picked row above the
	 * environment it beat.
	 */
	describe("the tooltip over a hovered token", () => {
		it("shows the value and the environment it came from", () => {
			const tokens = mountProvider();
			act(() => tokens.setHoveredToken({ name: "baseUrl", rect }));
			expect(cardText()).toContain("https://api.example.com");
			expect(cardText()).toContain("Staging");
		});

		it("says a secret is one, and never prints it", () => {
			const tokens = mountProvider();
			act(() => tokens.setHoveredToken({ name: "token", rect }));
			expect(cardText()).toContain("secret");
			// Mutation check: print `info.value` here and this fails - the reveal
			// gate in the popover would be walked around by a mouseover.
			expect(document.body.textContent).not.toContain("s3cr3t");
		});

		it("says a name nothing defines is not defined", () => {
			const tokens = mountProvider();
			act(() => tokens.setHoveredToken({ name: "missing", rect }));
			expect(cardText()).toContain("not defined");
		});

		it("describes a generator, which has no stored value to show", () => {
			const tokens = mountProvider();
			act(() => tokens.setHoveredToken({ name: "$guid", rect }));
			expect(cardText()).toMatch(/generated per use/);
		});

		it("answers with the picked row, above the scope it beat", () => {
			const tokens = mountProvider();
			act(() => tokens.setHoveredToken({ name: "email", rect }));
			expect(cardText()).toContain("grace@example.com");
			expect(cardText()).toContain("Bound row");
			// The environment it beat is the popover's business, not the card's.
			expect(cardText()).not.toContain("ada@example.com");
		});

		it("goes away when told to, and is not stacked under the popover", () => {
			const tokens = mountProvider();
			act(() => tokens.setHoveredToken({ name: "baseUrl", rect }));
			act(() => tokens.setHoveredToken(null));
			expect(screen.queryByText("https://api.example.com")).toBeNull();

			act(() => tokens.setHoveredToken({ name: "baseUrl", rect }));
			act(() => tokens.openTokenEditor({ name: "baseUrl", rect }));
			// The popover holds the value in a field; nothing prints it as text.
			expect(screen.queryByText("https://api.example.com")).toBeNull();
			expect(screen.getByDisplayValue("https://api.example.com")).toBeTruthy();
		});
	});

	it("writes through the request builder's own `updateVariable`", () => {
		const tokens = mountProvider();
		act(() => tokens.openTokenEditor({ name: "baseUrl", rect }));

		const field = screen.getByDisplayValue("https://api.example.com");
		fireEvent.change(field, { target: { value: "https://api.staging.example.com" } });
		fireEvent.keyDown(field, { key: "Enter" });
		expect(updateVariable).toHaveBeenCalledWith(
			"baseUrl",
			"https://api.staging.example.com",
			"environment"
		);
	});
});
