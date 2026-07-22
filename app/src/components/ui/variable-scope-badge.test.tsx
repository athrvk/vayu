/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A scope is one colour, in every place it appears.
 *
 * The compact badge — the one in the `{{` autocomplete list — re-derived its
 * colours inline instead of reading `SCOPE_CONFIG`, and special-cased global to
 * `bg-muted`. So a global variable showed a grey `G` in the autocomplete and a
 * green "Global" in the popover, while `VariablesCategoryTree` and
 * `VariableTableEditor` painted the same scope green in the sidebar.
 *
 * `--scope-global` is a real token in both themes and `docs/design-system.md`
 * gives it the same convention as collection and environment. The neutral was
 * the odd one out, not the design.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VariableScopeBadge } from "./variable-scope-badge";
import type { VariableScope } from "@/types";

const SCOPES: VariableScope[] = ["global", "collection", "environment"];

const badgeFor = (scope: VariableScope, variant: "compact" | "full") => {
	const { container } = render(<VariableScopeBadge scope={scope} variant={variant} />);
	return container.querySelector('[data-slot="badge"]') as HTMLElement;
};

describe("every scope carries its own hue", () => {
	it.each(SCOPES)("compact %s uses its scope token, not a neutral", (scope) => {
		const cls = badgeFor(scope, "compact").className;
		expect(cls).toContain(`bg-scope-${scope}/10`);
		expect(cls).toContain(`text-scope-${scope}`);
		// The specific regression: global fell back to the neutral surface.
		expect(cls).not.toMatch(/bg-muted/);
	});

	it.each(SCOPES)("full %s uses the same token as compact", (scope) => {
		expect(badgeFor(scope, "full").className).toContain(`bg-scope-${scope}/10`);
	});

	it("gives the three scopes three different colours", () => {
		const tints = SCOPES.map((s) => {
			const cls = badgeFor(s, "compact").className;
			return cls.match(/bg-scope-\w+\/10/)?.[0];
		});
		expect(new Set(tints).size).toBe(3);
	});
});

describe("labels", () => {
	it("abbreviates in compact and spells out in full", () => {
		render(<VariableScopeBadge scope="global" variant="compact" />);
		expect(screen.getByText("G")).toBeInTheDocument();

		render(<VariableScopeBadge scope="global" variant="full" />);
		expect(screen.getByText("Global")).toBeInTheDocument();
	});
});

describe("neither variant is interactive", () => {
	/**
	 * The full variant was `variant="secondary"`, whose `hover:bg-secondary/80`
	 * outlives the tint that replaces its background — so it greyed out under
	 * the pointer. A source scan cannot catch this one: the background arrives
	 * through `config.tint`, not a literal in the JSX.
	 */
	it.each(SCOPES)("compact %s has no hover background", (scope) => {
		expect(badgeFor(scope, "compact").className).not.toMatch(/hover:bg-/);
	});

	it.each(SCOPES)("full %s has no hover background", (scope) => {
		expect(badgeFor(scope, "full").className).not.toMatch(/hover:bg-/);
	});
});
