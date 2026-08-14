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
 * A `{{$guid}}` token must not be painted as an undefined variable.
 *
 * `EditableVariable` colours a name nothing defines with `text-destructive-text`
 * and hovers it to "not defined". Dynamic variables are defined nowhere by
 * design and resolve every single time, so routing them through that component
 * would tell the user the opposite of what happens - which is why the overlay
 * checks the generator table before falling back to it.
 *
 * The shadowing case is the other half: a workspace that defines a variable
 * literally named `$guid` resolves to that value, so the token must be the
 * editable one, not the generator.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import type { ResolvedVariable } from "@/types";
import VariableInput from "./index";

const variables: Record<string, ResolvedVariable> = {};

/*
 * The scope is a prop now, not a mocked module. This file used to `vi.mock` the
 * request-builder context because the component reached for it in its body -
 * the coupling that made the key/value table unmountable anywhere else (#564).
 */
const scope = variableSupportStub(variables);

function overlayOf(value: string) {
	const { container } = render(
		<TooltipProvider>
			<VariableInput value={value} onChange={() => {}} placeholder="URL" variables={scope} />
		</TooltipProvider>
	);
	const overlay = container.querySelector('[aria-hidden="true"]');
	expect(overlay).toBeTruthy();
	return overlay as HTMLElement;
}

describe("a known dynamic variable in the overlay", () => {
	it("renders the token", () => {
		// Guards the scan itself: an overlay that rendered nothing would pass
		// every "does not contain" assertion below while checking nothing.
		expect(overlayOf("https://x/y?id={{$guid}}").textContent).toContain("{{$guid}}");
	});

	it("is not painted as unresolved", () => {
		const overlay = overlayOf("https://x/y?id={{$guid}}");
		const token = overlay.querySelector("[data-variable-token] span");
		expect(token).toBeTruthy();
		expect(token!.className).not.toContain("text-destructive-text");
		expect(token!.className).toContain("text-muted-foreground");
	});

	it("offers nothing to edit - a generated value has no stored definition", () => {
		const overlay = overlayOf("{{$guid}}");
		/*
		 * EditableVariable's trigger is the popover's; the generator token is a
		 * plain span. Query the *role*: that trigger is a `<span role="button">`
		 * rather than a `<button>`, because an inline token must not break the
		 * text flow - so the `querySelector("button")` this used to run matched
		 * neither token and passed while checking nothing.
		 */
		expect(overlay.querySelector('[role="button"]')).toBeNull();
	});
});

describe("an unknown $name", () => {
	it("keeps the editable token, so it stays marked undefined", () => {
		const overlay = overlayOf("{{$randomInteger}}");
		const token = overlay.querySelector("[data-variable-token] span");
		expect(token).toBeTruthy();
		expect(token!.className).not.toContain("text-muted-foreground");
	});
});

describe("a workspace variable named like a generator", () => {
	it("wins, and gets the editable token", () => {
		variables.$guid = { value: "pinned", scope: "global" };
		try {
			const overlay = overlayOf("{{$guid}}");
			const token = overlay.querySelector("[data-variable-token] span");
			expect(token!.className).not.toContain("text-muted-foreground");
		} finally {
			delete variables.$guid;
		}
	});
});
