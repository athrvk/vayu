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
 * The "References:" chips on the collection's pre- and post-request tabs.
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
	it("chips both syntaxes, pm references first", () => {
		render(<ScriptTab collection={makeCollection(SCRIPT)} kind={kind} />);

		// A text function rather than a regex: `variable-pattern-single-source`
		// bans a `{{...}}` matcher outside `constants/variables.ts`, and it is
		// right to - a test that declares one is a copy like any other.
		const chips = screen.getAllByText((text) => text.startsWith("{{") && text.endsWith("}}"));

		expect(chips.map((el) => el.textContent)).toEqual([
			"{{auth_token}}",
			"{{region}}",
			"{{base_url}}",
			"{{tenant_id}}",
		]);
	});

	it("drops the empty token the inline copy used to chip", () => {
		// `{{ }}` matches the pattern and trims to "", which the shared helper
		// filters and the tab's own copy did not - it rendered an empty chip.
		render(<ScriptTab collection={makeCollection("const x = `{{ }}`;")} kind={kind} />);

		expect(screen.queryByText("References:")).not.toBeInTheDocument();
	});

	it("shows nothing for a script that mentions no variable", () => {
		render(<ScriptTab collection={makeCollection("console.log(1);")} kind={kind} />);

		expect(screen.queryByText("References:")).not.toBeInTheDocument();
	});
});
