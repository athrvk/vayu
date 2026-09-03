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
 * The "Referenced:" chips must not call a data column broken (issue #604).
 *
 * The row chips each name the script mentions and paints it
 * `allVariables[name] ? "secondary" : "destructive"`. A `{{data.email}}` can
 * never be in `allVariables` - the namespace is disjoint from the scopes by
 * design - so every data column in a script was painted the destructive red
 * that #592 removed from the builder, in the one row that claims to say whether
 * a name resolves.
 *
 * The chip reads `describeDataToken`, the same function the token in the URL bar
 * reads, so the two surfaces cannot come to disagree about which columns a
 * contract declares. These tests pin the three states through the panel rather
 * than the helper: the helper was already right, and the defect was that this
 * surface never asked it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import ScriptPanel from "./script/ScriptPanel";
import { DATA_TOKEN_TONE_CLASS } from "@/lib/data-token-tone";
import type { VariableOrigin } from "@/types/domain";

/** Monaco does not run under jsdom; nothing here tests the editor. */
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

/**
 * One data column, one ordinary name read through `pm` and nothing defines, and
 * one plain `{{}}` - the three paints this row has, in one script.
 *
 * `missing_key` is a `pm.*.get()` deliberately: after #659 the destructive paint
 * belongs to names a script actually *reads*, and a `{{missing_key}}` would be
 * the neutral template chip instead.
 */
const SCRIPT = [
	'const to = "{{data.email}}";',
	'const k = pm.environment.get("missing_key");',
	'const u = "{{base_url}}/orders";',
].join("\n");

/**
 * The same column, reached through each accessor that can see the bound row
 * (issue #1063). Separate from `SCRIPT` because these names must not disturb
 * the three paints above, and because the chip row only chips the first five.
 */
const ROW_SCRIPT = [
	'const a = pm.variables.get("email");',
	'const b = pm.iterationData.get("city");',
].join("\n");

const contract: { value: { collectionName: string; columns: string[] } | undefined } = {
	value: undefined,
};

/** What `getAllVariables()` answers with - empty unless a case says otherwise. */
const variables: { value: Record<string, { value: string; scope: string }> } = { value: {} };

/**
 * What `getVariableOrigins(name)` answers with - empty unless a case says
 * otherwise. This is the list `describeScopedRead` (issue #1196) reads to see
 * a losing definition `allVariables`, keyed on the winner alone, cannot show.
 */
const origins: { value: Record<string, VariableOrigin[]> } = { value: {} };

/** The script under the panel - `SCRIPT` unless a case swaps it. */
const script = { value: SCRIPT };

vi.mock("../../../context", () => ({
	useRequestBuilderContext: () => ({
		// `collectionId: null` keeps the inherited-scripts notice out of the tree,
		// which would otherwise want a QueryClient. The contract this panel paints
		// against arrives as `dataColumns`, already resolved by the provider, so
		// the chain walk is not what these cases are about.
		get request() {
			return {
				preRequestScript: script.value,
				testScript: script.value,
				collectionId: null,
			};
		},
		updateField: () => {},
		getAllVariables: () => variables.value,
		getVariableOrigins: (name: string) => origins.value[name] ?? [],
		get dataColumns() {
			return contract.value;
		},
		inheritedPreScripts: [],
		inheritedPostScripts: [],
		legacyPreScript: "",
		legacyPostScript: "",
	}),
}));

/**
 * `collectionId: null` leaves InheritedScriptsNotice nothing to inherit, but it
 * still calls `useCollectionAncestors`, which wants a QueryClient this test does
 * not stand up. Mocked here, not tested here - the same reason
 * `script-panels.test.tsx` mocks it.
 */
vi.mock("@/queries/collections", () => ({
	useCollectionAncestors: () => [],
}));

/** The chip carrying `name`, by its text. */
function chipFor(container: HTMLElement, name: string): HTMLElement {
	const chip = [...container.querySelectorAll<HTMLElement>('[data-slot="badge"]')].find(
		(el) => el.textContent === name
	);
	expect(chip, `no chip for ${name}`).toBeTruthy();
	return chip!;
}

beforeEach(() => {
	contract.value = undefined;
	variables.value = {};
	origins.value = {};
	script.value = SCRIPT;
});

describe("a {{data.*}} name in the chip row", () => {
	it("is never painted destructive, with no contract in scope", () => {
		const { container } = render(<ScriptPanel variant="pre" />);

		const chip = chipFor(container, "data.email");
		expect(chip.className).not.toContain("bg-destructive");
		expect(chip.className).toContain("text-muted-foreground");
	});

	it("stays informational when the contract declares the column", () => {
		contract.value = { collectionName: "Orders", columns: ["email"] };
		const { container } = render(<ScriptPanel variant="pre" />);

		const chip = chipFor(container, "data.email");
		expect(chip.className).toContain("text-muted-foreground");
		expect(chip.getAttribute("title")).toContain("declared in Orders");
	});

	it("warns - amber, not red - when no contract in scope declares it", () => {
		contract.value = { collectionName: "Orders", columns: ["name"] };
		const { container } = render(<ScriptPanel variant="pre" />);

		const chip = chipFor(container, "data.email");
		expect(chip.className).toContain("text-warning-text");
		expect(chip.className).not.toContain("bg-destructive");
		// The fix is nearly always a typo, so the chip carries the declared list.
		expect(chip.getAttribute("title")).toContain("declared: name");
	});
});

describe("an ordinary name nothing defines, read through pm", () => {
	it("keeps the destructive chip - that reading is still true for it", () => {
		const { container } = render(<ScriptPanel variant="pre" />);

		// Guards the scan as much as the behaviour: if no chip were rendered at
		// all, every "not destructive" assertion above would pass vacuously.
		expect(chipFor(container, "missing_key").className).toContain("bg-destructive");
	});
});

/**
 * The rest of what #604 left behind (issue #659 item 3).
 *
 * `{{base_url}}` in a script is literal characters - the engine never
 * interpolates script source (decision D16) - so the resolved/unresolved pair
 * cannot apply to it in either direction. Painting it green said a send would
 * substitute it; painting it red said a name that is doing nothing is broken.
 */
describe("a plain {{name}} the script only contains", () => {
	it("is neutral, spelled as a template, and says why", () => {
		const { container } = render(<ScriptPanel variant="pre" />);

		const chip = chipFor(container, "{{base_url}}");
		expect(chip.className).toContain("text-muted-foreground");
		expect(chip.className).not.toContain("bg-destructive");
		expect(chip.getAttribute("title")).toContain("not interpolated");
	});

	it("stays neutral even when a variable of that name is in scope", () => {
		// The half a "paint it green when defined" rule would get wrong: the
		// variable existing changes nothing about what this script does.
		variables.value = { base_url: { value: "https://api.example.com", scope: "global" } };
		const { container } = render(<ScriptPanel variant="pre" />);

		const chip = chipFor(container, "{{base_url}}");
		expect(chip.className).toContain("text-muted-foreground");
		expect(chip.className).not.toContain("bg-secondary");
	});
});

/**
 * A bare column name, read through an accessor that sees the bound row
 * (issue #1063).
 *
 * Both of these were chipped *nowhere at all* before: `referencedVariables`
 * matched three accessors and neither of these was one, so the names a
 * data-driven script actually reads were the ones the row stayed silent about.
 * The paint they get now is the `{{data.*}}` paint, from the same table, because
 * the spelling is the only thing that differed.
 */
describe("a column read through pm, by its bare name", () => {
	beforeEach(() => {
		script.value = ROW_SCRIPT;
	});

	it("chips a pm.variables read like the pm.iterationData read beside it", () => {
		// The acceptance criterion itself: one column, two accessors, one paint.
		contract.value = { collectionName: "Orders", columns: ["email", "city"] };
		const { container } = render(<ScriptPanel variant="pre" />);

		const merged = chipFor(container, "email");
		const row = chipFor(container, "city");
		expect(merged.className).toBe(row.className);
		expect(merged.className).toContain("text-muted-foreground");
		expect(merged.className).not.toContain("bg-destructive");
	});

	it("says the row is what answers the name, which is why it is not red", () => {
		contract.value = { collectionName: "Orders", columns: ["email", "city"] };
		const { container } = render(<ScriptPanel variant="pre" />);

		expect(chipFor(container, "email").getAttribute("title")).toContain(
			"bound row's column answers this name"
		);
		expect(chipFor(container, "city").getAttribute("title")).toContain("declared in Orders");
	});

	it("warns - amber, not red - for a pm.iterationData read of an undeclared column", () => {
		contract.value = { collectionName: "Orders", columns: ["email"] };
		const { container } = render(<ScriptPanel variant="pre" />);

		const chip = chipFor(container, "city");
		expect(chip.className).toContain("text-warning-text");
		expect(chip.className).not.toContain("bg-destructive");
	});

	it("never calls a pm.iterationData read undefined, with no contract in scope", () => {
		/*
		 * The state that has to be handled rather than fall through: a column can
		 * never be in `allVariables`, so the resolved/unresolved pair answers
		 * "destructive" for every column read - the #604 defect, arriving by a
		 * second door.
		 */
		const { container } = render(<ScriptPanel variant="pre" />);

		expect(chipFor(container, "city").className).not.toContain("bg-destructive");
	});

	it("leaves a pm.variables read painted as the variable a scope defines", () => {
		/*
		 * The row does win at run time while one is bound (issue #1007), but which
		 * of the two the builder *paints* is issue #1064's question, and this
		 * panel draws the line where `VariableInput` already draws it. The
		 * `pm.iterationData` chip beside it is unaffected: that accessor reads no
		 * scope, so a variable of the same name says nothing about it.
		 */
		contract.value = { collectionName: "Orders", columns: ["email", "city"] };
		variables.value = { email: { value: "ops@example.com", scope: "environment" } };
		const { container } = render(<ScriptPanel variant="pre" />);

		expect(chipFor(container, "email").className).toContain("bg-secondary");
		expect(chipFor(container, "city").className).toContain("text-muted-foreground");
	});

	it("does not tell a pm read that its characters reach the script verbatim", () => {
		/*
		 * A `data.*` name reached through `pm.*.get()` takes the column paint,
		 * but not the interpolation note beside it: that note belongs to the
		 * spelling that really is literal characters, and on a call it describes
		 * something the author did not write. The collection tab draws the same
		 * line (issue #1075), and the two must not answer this differently.
		 */
		script.value = 'const a = pm.variables.get("data.email");';
		contract.value = { collectionName: "Orders", columns: ["email"] };
		const { container } = render(<ScriptPanel variant="pre" />);

		const title = chipFor(container, "data.email").getAttribute("title")!;
		expect(title).toContain("declared in Orders");
		expect(title).not.toContain("not interpolated");
	});

	it("keeps the destructive chip for a pm.variables read that names no column", () => {
		// The merged accessor is still a variable read for every other name, and
		// this is the case that proves the new branch did not swallow the old one.
		contract.value = { collectionName: "Orders", columns: ["city"] };
		const { container } = render(<ScriptPanel variant="pre" />);

		expect(chipFor(container, "email").className).toContain("bg-destructive");
	});
});

/**
 * A single-scope read whose own scope answers emptily while another scope
 * holds the value (issue #1196).
 *
 * `shop_domain` is the reported trap: a Postman import leaves an enabled,
 * empty row at collection scope, and `pm.collectionVariables.get("shop_domain")`
 * honestly returns `""`. Nothing about that is wrong on its own - but the
 * environment defines the same name with a real value, `allVariables` reports
 * the *winner* (the environment's), and a chip keyed on `allVariables` alone
 * called this read healthy while it silently returned empty. The origins list
 * is what tells the two apart, so `getAllVariables()` has to report the name
 * resolved here exactly as it did when the bug was filed - a fixture that
 * leaves `shop_domain` out of `allVariables` cannot reproduce what fooled the
 * old chip in the first place.
 */
describe("a single-scope pm read whose own scope answers emptily (issue #1196)", () => {
	const TRAP_SCRIPT = 'const d = pm.collectionVariables.get("shop_domain");';

	// Mutation check: delete the `describeScopedRead` branch from ScriptPanel
	// (or make it always return null) and this case is the first to redden -
	// the chip falls back to the destructive/secondary pair and, because
	// `allVariables` reports the name resolved, paints the healthy chip that
	// hid the bug.
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
		// The winner `allVariables` reports - exactly what made this chip look
		// healthy before #1196's fix, so the fixture has to keep reporting it.
		variables.value = { shop_domain: { value: "shop.example.com", scope: "environment" } };
		script.value = TRAP_SCRIPT;

		const { container } = render(<ScriptPanel variant="pre" />);
		const chip = chipFor(container, "shop_domain");

		expect(chip.className).toContain(DATA_TOKEN_TONE_CLASS.warning);
		const title = chip.getAttribute("title")!;
		expect(title).toContain("Empty at collection scope");
		expect(title).toContain("environment - Staging");
		// One of these definitions may be a secret; the tooltip names sources,
		// never values.
		expect(title).not.toContain("shop.example.com");
	});

	it("stays the ordinary healthy chip when the accessor's own scope actually answers", () => {
		/*
		 * Same script, but the collection row holds a real value of its own. The
		 * environment still wins the ladder - it outranks the collection, so it is
		 * last and takes `winner` - and that is the point: warning on "another
		 * scope wins" would fire on most healthy scripts. What decides is whether
		 * the accessor's *own* scope answers, and here it does.
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
		script.value = TRAP_SCRIPT;

		const { container } = render(<ScriptPanel variant="pre" />);
		const chip = chipFor(container, "shop_domain");

		expect(chip.className).not.toContain(DATA_TOKEN_TONE_CLASS.warning);
		// The paint this read fell back to before #1196 ever existed: resolved,
		// so the ordinary secondary chip - not the destructive one, and not amber.
		expect(chip.className).toContain("bg-secondary");
	});

	it("never warns for the merged pm.variables read of the same name", () => {
		// `pm.variables` returns the winner by construction, so it is correct
		// regardless of what a single scope answers - the trap above is specific
		// to the single-scope accessors and must not leak into this one.
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
		script.value = 'const d = pm.variables.get("shop_domain");';

		const { container } = render(<ScriptPanel variant="pre" />);

		expect(chipFor(container, "shop_domain").className).not.toContain(
			DATA_TOKEN_TONE_CLASS.warning
		);
	});
});
