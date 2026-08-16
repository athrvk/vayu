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
 * The "Names mentioned:" chips on the collection's pre- and post-request tabs.
 *
 * This tab re-implemented `referencedVariables` inline - the same two regexes
 * and the same dedupe as the request builder's script panel - so nothing that
 * landed in the shared helper ever reached it. Both kinds are rendered here
 * because the duplicate was in the shared component: fixing one kind fixes
 * both, and a test of only `pre` could not tell the difference.
 *
 * `referencedVariables` itself is covered by `lib/referenced-variables.test.ts`;
 * what these assert is the wiring, which is the part a unit test of the helper
 * cannot see.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Collection } from "@/types";
import ScriptTab from "./ScriptTab";

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

// Monaco does not run in jsdom, and the editor is not what this guards.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const SCRIPT = [
	'const token = pm.environment.get("auth_token");',
	'const region = pm.globals.get("region");',
	'const url = "{{base_url}}/orders?tenant={{ tenant_id }}";',
	// Repeats of names already seen, plus an empty token: neither should chip.
	'pm.environment.get("auth_token");',
	"const nothing = `{{ }}`;",
].join("\n");

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

beforeEach(() => {
	mutation.mutateAsync.mockClear();
});

describe.each(["pre", "post"] as const)("%s-request script tab", (kind) => {
	it("chips both syntaxes, pm references first and in the syntax each was written in", () => {
		const { container } = render(<ScriptTab collection={makeCollection(SCRIPT)} kind={kind} />);

		const chips = [...container.querySelectorAll('[data-slot="badge"]')].map(
			(el) => el.textContent
		);

		/*
		 * The order is the helper's - every `pm` reference, then every template
		 * one - and the *spelling* is the fix (issue #659). `auth_token` and
		 * `region` are read through `pm.*.get()`, so printing them as
		 * `{{auth_token}}` claimed a template the script does not contain; and a
		 * template chip that looks like a resolving one claims a substitution
		 * the engine never performs, since script source is not interpolated.
		 */
		expect(chips).toEqual(["auth_token", "region", "{{base_url}}", "{{tenant_id}}"]);
	});

	// The `{{}}` chips are the ones that must not read as resolving. The tooltip
	// is where the rule lives; without it the muted paint is just a colour.
	it("tells a template chip apart from a pm one, and says why", () => {
		const { container } = render(<ScriptTab collection={makeCollection(SCRIPT)} kind={kind} />);

		const chipFor = (text: string) =>
			[...container.querySelectorAll<HTMLElement>('[data-slot="badge"]')].find(
				(el) => el.textContent === text
			);

		const template = chipFor("{{base_url}}");
		expect(template).toBeTruthy();
		expect(template?.getAttribute("title")).toContain("not interpolated");
		expect(template?.className).toContain("text-muted-foreground");

		const pmChip = chipFor("auth_token");
		expect(pmChip).toBeTruthy();
		expect(pmChip?.getAttribute("title")).toBeNull();
		expect(pmChip?.className).toContain("text-variable");
	});

	it("drops the empty token the inline copy used to chip", () => {
		// `{{ }}` matches the pattern and trims to "", which the shared helper
		// filters and the tab's own copy did not - it rendered an empty chip.
		render(<ScriptTab collection={makeCollection("const x = `{{ }}`;")} kind={kind} />);

		expect(screen.queryByText("Names mentioned:")).not.toBeInTheDocument();
	});

	it("shows nothing for a script that mentions no variable", () => {
		render(<ScriptTab collection={makeCollection("console.log(1);")} kind={kind} />);

		expect(screen.queryByText("Names mentioned:")).not.toBeInTheDocument();
	});
});
