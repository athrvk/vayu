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

const contract: { value: { collectionName: string; columns: string[] } | undefined } = {
	value: undefined,
};

/** What `getAllVariables()` answers with - empty unless a case says otherwise. */
const variables: { value: Record<string, { value: string; scope: string }> } = { value: {} };

vi.mock("../../../context", () => ({
	useRequestBuilderContext: () => ({
		// `collectionId: null` keeps the inherited-scripts notice out of the tree,
		// which would otherwise want a QueryClient. The contract this panel paints
		// against arrives as `dataColumns`, already resolved by the provider, so
		// the chain walk is not what these cases are about.
		request: { preRequestScript: SCRIPT, testScript: SCRIPT, collectionId: null },
		updateField: () => {},
		getAllVariables: () => variables.value,
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
