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
 * The two script panels, which are near-identical by construction.
 *
 * `PreScriptPanel` and `TestScriptPanel` differ only in the field they bind, the
 * sentence at the top and the quick-reference block; the variable-scanning and
 * variable-listing machinery is duplicated line for line. That duplication is
 * left in place deliberately (see the note in each file), so every test here
 * runs against both - a fix applied to one and not the other fails.
 *
 * Two defects:
 *
 *   - The scope chips in the full variable list were hand-rolled as
 *     `<Badge variant="outline">{scope[0].toUpperCase()}</Badge>`, bypassing
 *     `VariableScopeBadge` - the primitive that owns the scope colours. Global,
 *     collection and environment therefore all rendered as the same colourless
 *     chip, in the one place a script author looks to tell them apart. The same
 *     class of bug as the autocomplete's grey global badge, in a surface the
 *     earlier fix did not reach because it does not use the primitive.
 *
 *   - Opening the full list *replaced* the "Referenced:" row. The button that
 *     promised more information removed the more useful half.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import PreScriptPanel from "./PreScriptPanel";
import TestScriptPanel from "./TestScriptPanel";

/** Monaco does not run under jsdom; nothing here tests the editor. */
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const SCRIPT = `pm.environment.get("token"); const u = "{{base_url}}"; pm.globals.get("run_id");`;

const ALL_VARIABLES = {
	token: { value: "abc123", scope: "environment" as const },
	base_url: { value: "https://api.example.com", scope: "collection" as const },
	run_id: { value: "42", scope: "global" as const },
};

vi.mock("../../../context", () => ({
	useRequestBuilderContext: () => ({
		request: { preRequestScript: SCRIPT, testScript: SCRIPT },
		updateField: () => {},
		getAllVariables: () => ALL_VARIABLES,
	}),
}));

/** Both panels, so a one-sided fix cannot pass. */
const PANELS = [
	["pre-request", PreScriptPanel],
	["tests", TestScriptPanel],
] as const;

/** The compact scope chips inside the full variable list. */
function scopeChips(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>('[data-slot="badge"]')).filter((el) =>
		/^[GCE]$/.test(el.textContent?.trim() ?? "")
	);
}

function openFullList(container: HTMLElement) {
	const button = Array.from(container.querySelectorAll("button")).find((b) =>
		/all variables/i.test(b.textContent ?? "")
	);
	expect(button, "the panel should offer a full variable list").toBeTruthy();
	fireEvent.click(button!);
}

describe.each(PANELS)("%s panel", (_name, Panel) => {
	it("lists the variables the script references", () => {
		const { container } = render(<Panel />);
		expect(container.textContent).toContain("Referenced:");
		// One from pm.*.get(), one from a {{template}} - both scanners run.
		expect(container.textContent).toContain("token");
		expect(container.textContent).toContain("base_url");
	});

	it("keeps the referenced list visible once the full list opens", () => {
		const { container } = render(<Panel />);
		openFullList(container);

		expect(container.textContent).toContain("Referenced:");
	});

	it("shows every variable in scope once the full list opens", () => {
		const { container } = render(<Panel />);
		expect(scopeChips(container)).toHaveLength(0);

		openFullList(container);
		expect(scopeChips(container)).toHaveLength(3);
	});

	it("gives each scope its own colour, via the shared primitive", () => {
		const { container } = render(<Panel />);
		openFullList(container);

		const classes = scopeChips(container).map((el) => el.className);
		expect(classes).toHaveLength(3);

		// The defect: a hand-rolled `variant="outline"` chip paints no scope
		// colour, so all three were identical. Distinctness is the assertion -
		// it holds whatever the individual hues are.
		expect(new Set(classes).size).toBe(3);
		for (const cls of classes) {
			expect(cls).toMatch(/\btext-scope-(global|collection|environment)\b/);
		}
	});
});
