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
 * A `{{$vu}}` token must not be painted as an undefined variable (issue #1101).
 *
 * `EditableVariable` colours a name nothing defines with `text-destructive-text`
 * and offers to create it. For the identity namespace that offer is a trap: the
 * resolver answers `$vu` and `$iteration` ahead of every scope
 * (`lookupVariable`), so a variable created with either name would never be
 * consulted - and the token itself always binds, from the iteration that sends
 * the request. The undefined paint marked the one case that cannot fail.
 *
 * The `{{$vus}}` case is the half that must not move: the names are matched
 * exactly, so a near-miss is an ordinary unknown `$name` that reaches the wire
 * in braces, and the undefined paint is how the reader spots it (issue #186).
 *
 * The shadowing case is the opposite of the generator one, which is why it is
 * asserted rather than assumed: a workspace variable named `$guid` wins and
 * takes the editable token, but one named `$vu` shadows nothing.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import type { ResolvedVariable } from "@/types";
import VariableInput from "./index";

const variables: Record<string, ResolvedVariable> = {};

const scope = variableSupportStub(variables);

function renderInput(value: string) {
	const { container } = render(
		<TooltipProvider delayDuration={0}>
			<VariableInput value={value} onChange={() => {}} placeholder="URL" variables={scope} />
		</TooltipProvider>
	);
	const overlay = container.querySelector('[aria-hidden="true"]');
	expect(overlay).toBeTruthy();
	return overlay as HTMLElement;
}

/** The hover Radix actually listens for on a tooltip trigger. */
function hover(token: HTMLElement) {
	const trigger = token.firstElementChild ?? token;
	fireEvent.pointerMove(trigger, { pointerType: "mouse" });
}

describe.each(["$vu", "$iteration"])("an identity token in the overlay", (name) => {
	it(`renders {{${name}}}`, () => {
		// Guards the scan itself: an overlay that rendered nothing would pass
		// every "does not contain" assertion below while checking nothing.
		expect(renderInput(`https://x/y?u={{${name}}}`).textContent).toContain(`{{${name}}}`);
	});

	it(`paints {{${name}}} as a run-time token, not as unresolved`, () => {
		const overlay = renderInput(`https://x/y?u={{${name}}}`);
		const token = overlay.querySelector("[data-variable-token] span");
		expect(token).toBeTruthy();
		expect(token!.className).not.toContain("text-destructive-text");
		expect(token!.className).toContain("text-muted-foreground");
	});

	it(`offers nothing to define for {{${name}}} - no scope can answer it`, () => {
		/*
		 * EditableVariable's trigger is the popover's, a `<span role="button">`
		 * rather than a `<button>` so an inline token does not break the text
		 * flow. The run-time token is a plain span, so the role is absent.
		 */
		expect(renderInput(`{{${name}}}`).querySelector('[role="button"]')).toBeNull();
	});

	it(`says when {{${name}}} is bound`, async () => {
		const overlay = renderInput(`{{${name}}}`);

		hover(overlay.querySelector<HTMLElement>("[data-runtime-token]")!);

		const tooltip = await screen.findByRole("tooltip");
		expect(tooltip).toHaveTextContent("bound per iteration by the run");
		expect(tooltip).toHaveTextContent("not generated here");
	});
});

describe("a near-miss of an identity name", () => {
	it("keeps the editable token, so a typo stays marked undefined", () => {
		const overlay = renderInput("{{$vus}}");
		const token = overlay.querySelector("[data-variable-token] span");
		expect(token).toBeTruthy();
		expect(token!.className).not.toContain("text-muted-foreground");
		expect(token!.className).toContain("text-destructive-text");
	});
});

describe("a workspace variable named like an identity", () => {
	it("shadows nothing - the token stays the run-time one", () => {
		variables.$vu = { value: "pinned", scope: "global" };
		try {
			const overlay = renderInput("{{$vu}}");
			const token = overlay.querySelector("[data-variable-token] span");
			expect(token!.className).toContain("text-muted-foreground");
			expect(overlay.querySelector('[role="button"]')).toBeNull();
		} finally {
			delete variables.$vu;
		}
	});
});
