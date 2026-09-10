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
import type { VariableOrigin, VariableSupport } from "@/types";
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

/** Renders the provider and hands back the context an editor would hold. */
function mountProvider(overrides: Partial<VariableSupport> = {}) {
	let value: EditorVariableTokensValue | null = null;
	function Probe() {
		value = useEditorVariableTokensContext();
		return null;
	}
	// The app mounts one `TooltipProvider` at the root (`main.tsx`), and the
	// popover's secret-reveal button is a `TooltipIconButton` that needs it.
	render(
		<TooltipProvider>
			<EditorVariableTokensProvider support={{ ...support, ...overrides }}>
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

		it("says the token can be opened, since nothing else does now", () => {
			const tokens = mountProvider();
			act(() => tokens.setHoveredToken({ name: "baseUrl", rect }));
			// The Monaco hover this card replaced spelled the affordance out
			// ("⌘-click or ⇧⌘D to edit"); painted text on a canvas has no other
			// way to say it is pressable.
			expect(cardText()).toContain("Click to edit");
		});

		it("offers no edit line for a generator, which has nothing to open", () => {
			const tokens = mountProvider();
			act(() => tokens.setHoveredToken({ name: "$guid", rect }));
			expect(cardText()).not.toContain("Click to edit");
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

	/**
	 * A script's mention of a name, via `scriptHint` (issue #1220 script
	 * support). `TokenHoverCard`/`VariablePopover` never see the hint itself -
	 * they see whatever `classify` and the origins filter turn it into, which
	 * is what these cases pin.
	 */
	describe("a script's scriptHint", () => {
		it("answers a single scope's own read, not the ladder's winner", () => {
			const origins: VariableOrigin[] = [
				{ scope: "global", value: "https://old", enabled: true, winner: false },
				{
					scope: "environment",
					sourceName: "Staging",
					value: "https://api.example.com",
					enabled: true,
					winner: true,
				},
			];
			const tokens = mountProvider({ getVariableOrigins: () => origins });
			// pm.collectionVariables.get("baseUrl") - nothing at collection scope,
			// even though the environment wins the whole ladder.
			act(() =>
				tokens.setHoveredToken({
					name: "baseUrl",
					rect,
					scriptHint: { via: "scope", scope: "collection" },
				})
			);
			expect(cardText()).toContain("not defined");
		});

		it("never shows a bound row for a scope read that cannot see it", () => {
			const origins: VariableOrigin[] = [
				{ scope: "row", value: "grace@example.com", enabled: true, winner: true },
				{
					scope: "environment",
					sourceName: "Staging",
					value: "ada@example.com",
					enabled: true,
					winner: false,
				},
			];
			const tokens = mountProvider({ getVariableOrigins: () => origins });
			// pm.environment.get("email") - the row outranks every scope for
			// pm.variables, but this accessor never reads the row at all.
			act(() =>
				tokens.setHoveredToken({
					name: "email",
					rect,
					scriptHint: { via: "scope", scope: "environment" },
				})
			);
			expect(cardText()).toContain("ada@example.com");
			expect(cardText()).not.toContain("grace@example.com");
			expect(cardText()).not.toContain("Bound row");
		});

		it("answers pm.iterationData.get from the declared contract, when no row is bound yet", () => {
			// "phone" carries no origins in the shared fixture (no scope defines it,
			// no row bound to it), so this is the "not previewing a row" case.
			const tokens = mountProvider({
				dataColumns: { collectionId: "c1", collectionName: "Checkout", columns: ["phone"] },
			});
			act(() => tokens.setHoveredToken({ name: "phone", rect, scriptHint: { via: "row" } }));
			expect(cardText()).toContain("declared in Checkout");
		});

		it("answers pm.iterationData.get from the bound row itself, once one is picked", () => {
			// The shared fixture's "email" already carries a row origin (D18) - the
			// same row a `pm.variables` read would answer from, and what the run
			// will actually use, so this outranks the abstract column description.
			const tokens = mountProvider();
			act(() => tokens.setHoveredToken({ name: "email", rect, scriptHint: { via: "row" } }));
			expect(cardText()).toContain("grace@example.com");
			expect(cardText()).toContain("Bound row");
		});

		it("a bare script template is muted, not-interpolated, and never opens", () => {
			const tokens = mountProvider();
			act(() =>
				tokens.setHoveredToken({ name: "baseUrl", rect, scriptHint: { via: "bare" } })
			);
			expect(cardText()).toMatch(/not interpolated/i);
			expect(cardText()).toContain("pm.variables.replaceIn");
			expect(cardText()).not.toContain("Click to edit");

			act(() =>
				tokens.openTokenEditor({ name: "baseUrl", rect, scriptHint: { via: "bare" } })
			);
			// The provider itself refuses to render a popover for a "runtime"
			// classification (`scoped`, above `active && scoped &&`) - belt and
			// braces beside `useEditorVariableTokens`' own `open()` guard, which is
			// what actually stops a bare span's `openTokenEditor` from firing in
			// the running app.
			expect(screen.queryByRole("textbox")).toBeNull();
		});
	});

	describe("a support with no writable scope (the collection Elements tab, issue #1220)", () => {
		it("shows the value read-only rather than writing through a no-op updateVariable", () => {
			const tokens = mountProvider({ writableScopes: [] });
			act(() => tokens.openTokenEditor({ name: "baseUrl", rect }));

			expect(screen.getByText("https://api.example.com")).toBeInTheDocument();
			expect(screen.queryByDisplayValue("https://api.example.com")).toBeNull();
			// Mutation check: pass `support.updateVariable` unconditionally and this
			// fails - the field renders editable and a "Save" would look like it
			// worked while writing nowhere.
		});

		it("never promises an edit the hover card cannot deliver", () => {
			const tokens = mountProvider({ writableScopes: [] });
			act(() => tokens.setHoveredToken({ name: "baseUrl", rect }));

			// Mutation check: drop the `editable` gate on `TokenHoverCard` and this
			// fails - the card would say "Click to edit" over a popover that opens
			// with no field to type into.
			expect(cardText()).not.toContain("Click to edit");
			expect(cardText()).toContain("Click for details");
		});
	});
});
