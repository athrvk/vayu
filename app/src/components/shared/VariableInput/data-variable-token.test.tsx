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
 * A `{{data.column}}` token must not be painted as a broken variable.
 *
 * Typing one is the exact thing the data-file feature asks for, and the overlay
 * used to answer it with `EditableVariable`: red `text-destructive-text`, a
 * "not defined" tooltip, and a popover offering to create a variable of that
 * name. That offer is a trap - the namespace (#402) is disjoint from the
 * scopes, so both resolvers skip it and the created variable can never answer
 * for the column. The user follows the advice, gets a dead definition, and the
 * token is still red.
 *
 * The namespace is therefore read *before* the scope lookup, the same order
 * `resolveTemplate` reads it in - which is what the shadowing test below pins.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import type { ResolvedVariable } from "@/types";
import VariableInput from "./index";

const variables: Record<string, ResolvedVariable> = {};

const scope = variableSupportStub(variables);

function overlayOf(value: string) {
	const { container } = render(
		<TooltipProvider>
			<VariableInput value={value} onChange={() => {}} placeholder="URL" variables={scope} />
		</TooltipProvider>
	);
	const overlay = container.querySelector("[data-variable-overlay]");
	expect(overlay).toBeTruthy();
	return overlay as HTMLElement;
}

describe("a data-namespace token in the overlay", () => {
	it("renders the token", () => {
		// Guards the scan itself: an overlay that rendered nothing would pass
		// every "does not contain" assertion below while checking nothing.
		expect(overlayOf("https://x/users/{{data.id}}").textContent).toContain("{{data.id}}");
	});

	it("is not painted as unresolved", () => {
		const overlay = overlayOf("https://x/users/{{data.id}}");
		const token = overlay.querySelector("[data-variable-token] span");
		expect(token).toBeTruthy();
		expect(token!.className).not.toContain("text-destructive-text");
		expect(token!.className).toContain("text-muted-foreground");
	});

	it("offers nothing to edit or create - only a run's row can bind it", () => {
		const overlay = overlayOf("{{data.email}}");
		/*
		 * `EditableVariable`'s trigger is the popover's - the thing that carries
		 * the Create offer - and it is a `<span role="button">`, not a `<button>`
		 * (an inline token must not break the text flow). Query the role: a
		 * `querySelector("button")` here matches neither token and passes while
		 * checking nothing.
		 */
		expect(overlay.querySelector('[role="button"]')).toBeNull();
	});

	it("paints every placement the same way, not just the URL", () => {
		// Headers, params and body fields are all this same input.
		const overlay = overlayOf("Bearer {{data.token}} for {{data.tenant}}");
		const tokens = overlay.querySelectorAll("[data-variable-token] span");
		expect(tokens).toHaveLength(2);
		for (const token of tokens) {
			expect(token.className).toContain("text-muted-foreground");
		}
	});
});

describe("a variable named like a column", () => {
	it("does not answer for it - the namespace is disjoint, not a fourth tier", () => {
		/*
		 * The mirror of the generator case, and the opposite outcome: a stored
		 * `$guid` wins the token, a stored `data.id` does not. `resolveTemplate`
		 * checks the namespace before the lookup for exactly this reason, and a
		 * painter that checked the scopes first would show a green resolved token
		 * carrying a value the engine will never send.
		 */
		variables["data.id"] = { value: "not-this", scope: "global" };
		try {
			const overlay = overlayOf("{{data.id}}");
			const token = overlay.querySelector("[data-variable-token] span");
			expect(token!.className).toContain("text-muted-foreground");
			expect(overlay.querySelector('[role="button"]')).toBeNull();
		} finally {
			delete variables["data.id"];
		}
	});
});

describe("an ordinary unknown name", () => {
	it("still paints red and still offers the popover", () => {
		// The fix must not widen: everything outside the namespace is unchanged.
		const overlay = overlayOf("{{emial}}");
		const token = overlay.querySelector("[data-variable-token] span");
		expect(token!.className).toContain("text-destructive-text");
		expect(overlay.querySelector('[role="button"]')).toBeTruthy();
	});

	it("includes the bare prefix, which names no column", () => {
		// `{{data.}}` has nothing after the dot, so it addresses nothing and
		// follows the ordinary rule - the boundary `isDataVariableName` draws.
		const overlay = overlayOf("{{data.}}");
		const token = overlay.querySelector("[data-variable-token] span");
		expect(token!.className).toContain("text-destructive-text");
	});
});
