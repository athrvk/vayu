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
import { DATA_TOKEN_TONE_CLASS } from "@/lib/data-token-tone";
import type { VariableOrigin } from "@/types/domain";

const mutation = {
	mutateAsync: vi.fn(() => Promise.resolve()),
	mutate: vi.fn(),
	reset: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};

/**
 * The snippets list under the editor reads the engine's completion table
 * (#1223). Its own behaviour is `ScriptSnippets.test.tsx`; here it only needs
 * to not reach for a QueryClient this suite does not set up.
 */
vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => mutation,
}));

/**
 * The contract in scope and the variables in scope, which the chips now read
 * (issue #1075). Stubbed at the hook boundary rather than through the query
 * layer for the reason this file's header gives: what these assert is the
 * wiring, and standing up a real chain would be testing `useDataContract`
 * and `useVariableResolver`, which have their own suites.
 */
const contract: { value: { collectionName: string; columns: string[] } | undefined } = {
	value: undefined,
};
const variables: { value: Record<string, { value: string; scope: string }> } = { value: {} };

/**
 * What `getVariableOrigins(name)` answers with - empty unless a case says
 * otherwise. This is the list `describeScopedRead` (issue #1196) reads to see
 * a losing definition `allVariables`, keyed on the winner alone, cannot show.
 */
const origins: { value: Record<string, VariableOrigin[]> } = { value: {} };

vi.mock("@/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks")>()),
	useDataContract: () => contract.value,
	useVariableResolver: () => ({
		getAllVariables: () => variables.value,
		getVariableOrigins: (name: string) => origins.value[name] ?? [],
	}),
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
	contract.value = undefined;
	variables.value = {};
	origins.value = {};
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

	/**
	 * The column tones this tab did not have (issue #1075).
	 *
	 * The request panel got them at #604 and #1063; this one kept a two-way
	 * ladder, so the same script pasted into a collection's tab instead of a
	 * request's lost every column state - a flat accent chip that claims a
	 * variable answers, for a name only a bound row can answer. The paint below
	 * comes from `DATA_TOKEN_TONE_CLASS`, the one table both surfaces read, so
	 * a column this tab calls declared is the one that panel calls declared.
	 */
	describe("a data column, by either spelling", () => {
		const COLUMNS = [
			'const a = "{{data.email}}";',
			'const b = pm.variables.get("city");',
			'const c = pm.iterationData.get("zip");',
		].join("\n");

		const chipFor = (container: HTMLElement, text: string) =>
			[...container.querySelectorAll<HTMLElement>('[data-slot="badge"]')].find(
				(el) => el.textContent === text
			);

		it("paints all three spellings as columns, never as the accent", () => {
			contract.value = { collectionName: "Orders", columns: ["email", "city", "zip"] };
			const { container } = render(
				<ScriptTab collection={makeCollection(COLUMNS)} kind={kind} />
			);

			for (const text of ["{{data.email}}", "city", "zip"]) {
				const chip = chipFor(container, text);
				expect(chip, `no chip for ${text}`).toBeTruthy();
				expect(chip!.className).toContain("text-muted-foreground");
				// The accent is the paint that said a variable answers this name.
				expect(chip!.className).not.toContain("text-variable");
			}
		});

		it("names the declaring collection, which is where the column changes", () => {
			contract.value = { collectionName: "Orders", columns: ["email", "city", "zip"] };
			const { container } = render(
				<ScriptTab collection={makeCollection(COLUMNS)} kind={kind} />
			);

			expect(chipFor(container, "zip")!.getAttribute("title")).toContain(
				"declared in Orders"
			);
			expect(chipFor(container, "city")!.getAttribute("title")).toContain(
				"bound row's column answers this name"
			);
		});

		it("warns - amber, never destructive - for a column no contract declares", () => {
			contract.value = { collectionName: "Orders", columns: ["email"] };
			const { container } = render(
				<ScriptTab collection={makeCollection(COLUMNS)} kind={kind} />
			);

			const chip = chipFor(container, "zip")!;
			expect(chip.className).toContain("text-warning-text");
			expect(chip.className).not.toContain("bg-destructive");
		});

		it("stays a column with no contract in scope, not an undefined variable", () => {
			/*
			 * The third state, and the one that has to answer rather than fall
			 * through: a column can never be in the scopes, so handing it the
			 * ordinary pm paint would call every column read undefined - which is
			 * the reading #604 removed. The request panel pins this too; both
			 * surfaces need it, because either could regress alone.
			 */
			const { container } = render(
				<ScriptTab collection={makeCollection(COLUMNS)} kind={kind} />
			);

			for (const text of ["{{data.email}}", "zip"]) {
				const chip = chipFor(container, text);
				expect(chip, `no chip for ${text}`).toBeTruthy();
				expect(chip!.className).toContain("text-muted-foreground");
				expect(chip!.className).not.toContain("text-variable");
			}
		});

		it("does not tell a pm read that its characters reach the script verbatim", () => {
			// The tooltip half of parity with the request panel: the interpolation
			// note belongs to the spelling that is literal characters.
			contract.value = { collectionName: "Orders", columns: ["email"] };
			const { container } = render(
				<ScriptTab
					collection={makeCollection('pm.variables.get("data.email");')}
					kind={kind}
				/>
			);

			const title = chipFor(container, "data.email")!.getAttribute("title")!;
			expect(title).toContain("declared in Orders");
			expect(title).not.toContain("not interpolated");
		});

		it("leaves a pm.variables read as the variable a scope defines", () => {
			// The same line the request panel draws, and `VariableInput` before
			// it: which of the two wins on screen is issue #1064's question.
			contract.value = { collectionName: "Orders", columns: ["email", "city", "zip"] };
			variables.value = { city: { value: "Berlin", scope: "environment" } };
			const { container } = render(
				<ScriptTab collection={makeCollection(COLUMNS)} kind={kind} />
			);

			expect(chipFor(container, "city")!.className).toContain("text-variable");
			// The row's own accessor is unaffected: it reads no scope, so a
			// variable of that name says nothing about it.
			expect(chipFor(container, "zip")!.className).not.toContain("text-variable");
		});

		it("keeps the accent for an ordinary pm read, which is still a variable", () => {
			// The case that proves the column branch did not swallow the old one.
			contract.value = { collectionName: "Orders", columns: ["email"] };
			const { container } = render(
				<ScriptTab collection={makeCollection(SCRIPT)} kind={kind} />
			);

			expect(chipFor(container, "auth_token")!.className).toContain("text-variable");
		});
	});

	/**
	 * A single-scope read whose own scope answers emptily while another scope
	 * holds the value (issue #1196), on this tab's own chip - the same table
	 * as the request panel, but a separate render tree, so a regression here
	 * would not show up in that suite.
	 *
	 * `shop_domain` is the reported trap: an enabled, empty row at collection
	 * scope makes `pm.collectionVariables.get("shop_domain")` honestly return
	 * `""`, while the environment defines the same name for real. `allVariables`
	 * (what the old accent-vs-nothing paint read) reports only the *winner* -
	 * the environment's value - which is exactly what made this chip look
	 * resolved while quietly returning empty. The fixture keeps that winner in
	 * `allVariables`, or it would not reproduce what fooled the old chip.
	 */
	describe("a single-scope pm read whose own scope answers emptily (issue #1196)", () => {
		const TRAP_SCRIPT = 'const d = pm.collectionVariables.get("shop_domain");';

		const chipFor = (container: HTMLElement, text: string) =>
			[...container.querySelectorAll<HTMLElement>('[data-slot="badge"]')].find(
				(el) => el.textContent === text
			);

		// Mutation check: delete the `describeScopedRead` branch from ScriptTab
		// (or make it always return null) and this case is the first to redden -
		// the read falls through to the pm/accent pair and, because `allVariables`
		// reports the name resolved, paints the accent that hid the bug.
		it("warns, names the scope that answered empty and the scope that shadows it, and never prints the value", () => {
			origins.value = {
				shop_domain: [
					{ scope: "collection", value: "", enabled: true, winner: false },
					{
						scope: "environment",
						sourceName: "Staging",
						value: "shop.example.com",
						enabled: true,
						winner: true,
					},
				],
			};
			variables.value = { shop_domain: { value: "shop.example.com", scope: "environment" } };
			const { container } = render(
				<ScriptTab collection={makeCollection(TRAP_SCRIPT)} kind={kind} />
			);

			const chip = chipFor(container, "shop_domain")!;
			expect(chip.className).toContain(DATA_TOKEN_TONE_CLASS.warning);
			const title = chip.getAttribute("title")!;
			expect(title).toContain("Empty at collection scope");
			expect(title).toContain("environment - Staging");
			// One of these definitions may be a secret; the tooltip names sources,
			// never values.
			expect(title).not.toContain("shop.example.com");
		});

		it("stays the ordinary accent chip when the accessor's own scope actually answers", () => {
			/*
			 * Same script, but the collection row holds a real value of its own.
			 * The environment still wins the ladder - it outranks the collection,
			 * so it is last and takes `winner` - and that is the point: warning on
			 * "another scope wins" would fire on most healthy scripts. What decides
			 * is whether the accessor's *own* scope answers, and here it does.
			 */
			origins.value = {
				shop_domain: [
					{
						scope: "collection",
						value: "collection.example.com",
						enabled: true,
						winner: false,
					},
					{
						scope: "environment",
						sourceName: "Staging",
						value: "env.example.com",
						enabled: true,
						winner: true,
					},
				],
			};
			variables.value = { shop_domain: { value: "env.example.com", scope: "environment" } };
			const { container } = render(
				<ScriptTab collection={makeCollection(TRAP_SCRIPT)} kind={kind} />
			);

			const chip = chipFor(container, "shop_domain")!;
			expect(chip.className).not.toContain(DATA_TOKEN_TONE_CLASS.warning);
			// The paint this read fell back to before #1196 existed: a resolving
			// pm read, the same accent the other tests in this file check for.
			expect(chip.className).toContain("text-variable");
		});

		it("never warns for the merged pm.variables read of the same name", () => {
			// `pm.variables` returns the winner by construction, so it is correct
			// regardless of what a single scope answers - the trap above is
			// specific to the single-scope accessors and must not leak into it.
			origins.value = {
				shop_domain: [
					{ scope: "collection", value: "", enabled: true, winner: false },
					{
						scope: "environment",
						sourceName: "Staging",
						value: "shop.example.com",
						enabled: true,
						winner: true,
					},
				],
			};
			variables.value = { shop_domain: { value: "shop.example.com", scope: "environment" } };
			const { container } = render(
				<ScriptTab
					collection={makeCollection('const d = pm.variables.get("shop_domain");')}
					kind={kind}
				/>
			);

			expect(chipFor(container, "shop_domain")!.className).not.toContain(
				DATA_TOKEN_TONE_CLASS.warning
			);
		});
	});
});
