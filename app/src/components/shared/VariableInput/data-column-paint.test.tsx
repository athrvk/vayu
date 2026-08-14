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
 * `{{data.*}}` painted against the declared contract (issue #600).
 *
 * Phase 1 (#603) stopped painting these tokens red and left every one of them
 * neutral, because nothing in the app knew which columns existed. Now that a
 * collection declares them, the token can say which of three states it is in -
 * and the middle one is the whole point: `{{data.emial}}` binds nothing, and
 * without this the first anyone hears of it is a run that sent the braces.
 *
 * The three states are asserted through the rendered overlay rather than off
 * `describeDataToken` (which has its own suite): the wiring from
 * `VariableSupport.dataColumns` to a class on a span is what a screenshot would
 * show, and it is what would silently go missing.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import type { DataContractScope } from "@/types";
import VariableInput from "./index";

const contract: DataContractScope = {
	collectionName: "Checkout flow",
	columns: ["id", "email"],
};

function overlayOf(value: string, dataColumns?: DataContractScope) {
	const { container } = render(
		<TooltipProvider>
			<VariableInput
				value={value}
				onChange={() => {}}
				placeholder="URL"
				variables={variableSupportStub({}, { dataColumns })}
			/>
		</TooltipProvider>
	);
	const overlay = container.querySelector('[aria-hidden="true"]') as HTMLElement;
	expect(overlay).toBeTruthy();
	return overlay;
}

function tokenOf(value: string, dataColumns?: DataContractScope) {
	const token = overlayOf(value, dataColumns).querySelector("[data-variable-token] span");
	expect(token).toBeTruthy();
	return token as HTMLElement;
}

describe("a token naming a declared column", () => {
	it("is informational, never a warning", () => {
		const token = tokenOf("https://x/{{data.id}}", contract);
		expect(token.className).toContain("text-muted-foreground");
		expect(token.className).not.toContain("text-warning-text");
	});
});

describe("a token naming a column the contract does not declare", () => {
	it("is painted as a warning - not muted, and not the destructive red of an unknown variable", () => {
		const token = tokenOf("https://x/{{data.emial}}", contract);
		expect(token.className).toContain("text-warning-text");
		expect(token.className).not.toContain("text-muted-foreground");
		// A file the contract has drifted from can still carry the column, so
		// this is never the "nothing can ever bind this" tier.
		expect(token.className).not.toContain("text-destructive-text");
	});

	it("still offers nothing to create - the namespace is disjoint whatever the paint", () => {
		const overlay = overlayOf("{{data.emial}}", contract);
		expect(overlay.querySelector('[role="button"]')).toBeNull();
	});

	it("paints only the undeclared one when both kinds sit in the same field", () => {
		const overlay = overlayOf("{{data.id}}/{{data.emial}}", contract);
		const tokens = [...overlay.querySelectorAll("[data-variable-token] span")];
		expect(tokens).toHaveLength(2);
		expect(tokens[0].className).toContain("text-muted-foreground");
		expect(tokens[1].className).toContain("text-warning-text");
	});
});

describe("with no contract anywhere in the chain", () => {
	it("keeps phase 1's neutral token", () => {
		// Nothing was declared, so nothing can be validated. A token painted
		// amber for lacking a contract nobody wrote would be noise, and it would
		// be noise in every workspace that has never opened the Data tab.
		const token = tokenOf("https://x/{{data.emial}}");
		expect(token.className).toContain("text-muted-foreground");
		expect(token.className).not.toContain("text-warning-text");
	});
});
