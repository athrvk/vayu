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
 * ElementsTab (issue #1512) - the collection detail's replacement for the two
 * `ScriptTab`s, one list of typed behaviours via the shared `ElementList`.
 *
 * **A button, not a blur-commit, on the same basis as `AuthTab` (#446)** - see
 * the file's own doc comment. That means the whole-value conflict shape
 * `useEntityDraft` gives a single-field draft (a script string, an auth
 * config) rather than `InfoTab`'s per-key merge: while the draft is dirty, an
 * external write is held in `externalValue` and shown via
 * `ExternalChangeCallout`, never silently merged in. These cases mirror
 * `AuthTab.test.tsx`'s save/reset/failure pattern and the deleted
 * `ScriptTab.conflict.test.tsx`'s whole-value conflict scenario, adapted to
 * `elements`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Collection, DataContractScope, ElementDef, ElementKindSchema } from "@/types";
import type { VariableOrigin } from "@/types/domain";
import ElementsTab from "./ElementsTab";

const mutation = {
	// `mutateAsync`, not `mutate`: the tab's save has to be awaitable so the
	// quit flush and Ctrl/Cmd+S can report a real outcome (useDraftSaveContext).
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

/**
 * The contract and variables in scope for the "Names mentioned" row (#1553).
 * Stubbed at the `@/hooks` boundary - the same seam `ScriptTab.chips.test.tsx`
 * used before it - rather than standing up a real chain through a QueryClient
 * this suite does not otherwise need: what these tests guard is the wiring
 * (the row appears above a script element, reading this tab's own answers),
 * not `useDataContract`/`useVariableResolver` themselves, which have their
 * own suites.
 */
const dataContract: { value: DataContractScope | undefined } = { value: undefined };
const allVariables: { value: Record<string, { value: string; scope: string }> } = { value: {} };
const variableOrigins: { value: Record<string, VariableOrigin[]> } = { value: {} };

vi.mock("@/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks")>()),
	useDataContract: () => dataContract.value,
	useVariableResolver: () => ({
		getAllVariables: () => allVariables.value,
		getVariableOrigins: (name: string) => variableOrigins.value[name] ?? [],
	}),
}));

function kindSchema(kind: string, label: string, category: string): ElementKindSchema {
	return {
		kind,
		version: 1,
		label,
		description: `${label} description`,
		category,
		hotPathClass: "declarative",
		configSchema: { type: "object", properties: {} },
		phases: [],
	};
}

const KINDS: ElementKindSchema[] = [
	kindSchema("extract.json", "Extract JSON", "extract"),
	kindSchema("assert.status", "Assert Status", "assert"),
	kindSchema("script.pre", "Pre-request Script", "script"),
	kindSchema("script.post", "Test Script", "script"),
];

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useElementKindsQuery: () => ({ data: KINDS }),
	// ScriptElementForm's snippets list reads this; not what this file guards.
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

// Monaco does not run under jsdom.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

function extractElement(id: string): ElementDef {
	return { id, kind: "extract.json", enabled: true, config: {} };
}

function scriptElement(id: string, kind: "script.pre" | "script.post", script: string): ElementDef {
	return { id, kind, enabled: true, config: { script } };
}

function makeCollection(elements: ElementDef[]): Collection {
	return {
		id: "c1",
		name: "Acme API",
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function renderTab(collection: Collection) {
	return render(<ElementsTab collection={collection} />);
}

function openAddMenu() {
	fireEvent.pointerDown(screen.getByRole("button", { name: /add element/i }), { button: 0 });
}

beforeEach(() => {
	mutation.mutate.mockReset();
	mutation.mutateAsync.mockClear();
	mutation.reset.mockReset();
	mutation.isPending = false;
	mutation.isError = false;
	mutation.error = null;
	dataContract.value = undefined;
	allVariables.value = {};
	variableOrigins.value = {};
});

describe("ElementsTab - what it renders", () => {
	it("renders the info banner and the element list", () => {
		renderTab(makeCollection([extractElement("e1")]));

		// "before and after every request" is inside a <strong>, so the sentence
		// is split across elements - matched on the wrapping paragraph's text.
		const banner = screen.getByText(
			(_, el) =>
				el?.tagName === "P" &&
				/run\s+before and after every request/i.test(el.textContent ?? "")
		);
		expect(banner).toBeInTheDocument();
		expect(screen.getByText("Extract JSON")).toBeInTheDocument();
	});

	it("shows the empty-state label when the collection declares no elements", () => {
		renderTab(makeCollection([]));

		expect(screen.getByText(/no elements yet/i)).toBeInTheDocument();
	});
});

describe("ElementsTab - the Save button", () => {
	it("is disabled until an element is added, then enabled", async () => {
		renderTab(makeCollection([]));

		const save = screen.getByRole("button", { name: /save elements/i });
		expect(save).toBeDisabled();

		openAddMenu();
		fireEvent.click(await screen.findByRole("menuitem", { name: "Extract JSON" }));

		expect(save).toBeEnabled();
	});

	it("is disabled again once Reset discards the draft", async () => {
		renderTab(makeCollection([]));

		openAddMenu();
		fireEvent.click(await screen.findByRole("menuitem", { name: "Extract JSON" }));
		expect(screen.getByRole("button", { name: /save elements/i })).toBeEnabled();

		fireEvent.click(screen.getByRole("button", { name: /^reset$/i }));

		expect(screen.getByRole("button", { name: /save elements/i })).toBeDisabled();
		// The added row is gone - Reset discarded the draft, not just the button.
		expect(screen.queryByText("Extract JSON")).not.toBeInTheDocument();
	});

	it("sends the whole new elements array to the update-collection mutation", async () => {
		renderTab(makeCollection([extractElement("e1")]));

		fireEvent.click(screen.getByRole("switch", { name: /enable extract json/i }));
		fireEvent.click(screen.getByRole("button", { name: /save elements/i }));

		expect(mutation.mutateAsync).toHaveBeenCalledWith({
			id: "c1",
			elements: [{ ...extractElement("e1"), enabled: false }],
		});
	});

	it("says the fields are saved together, where the editing happens", () => {
		renderTab(makeCollection([]));
		expect(
			screen.getByText(/saved together, when you press Save Elements/i)
		).toBeInTheDocument();
	});
});

describe("ElementsTab - a save that fails", () => {
	it("surfaces the rejection instead of quietly re-enabling the button", () => {
		mutation.isError = true;
		mutation.error = new Error("database is locked");
		renderTab(makeCollection([extractElement("e1")]));

		expect(screen.getByText(/database is locked/i)).toBeInTheDocument();
	});
});

describe("ElementsTab - an external write while the draft is dirty", () => {
	it("holds the user's edit and shows a conflict rather than merging silently", async () => {
		const { rerender } = renderTab(makeCollection([extractElement("e1")]));

		// The user disables their own element - the draft is now dirty.
		fireEvent.click(screen.getByRole("switch", { name: /enable extract json/i }));

		// An agent writes a second element to the collection in the background.
		rerender(
			<ElementsTab
				collection={makeCollection([extractElement("e1"), extractElement("e2")])}
			/>
		);

		// The user's edit (disabled e1) survives - it is not overwritten by the
		// incoming write, and no second Extract JSON row appears from e2 either,
		// since the whole external value is held rather than merged.
		expect(screen.getByRole("switch", { name: /enable extract json/i })).toHaveAttribute(
			"aria-checked",
			"false"
		);
		expect(screen.getByText(/changed elsewhere/i)).toBeInTheDocument();
	});

	it("Take theirs adopts the external elements and clears the conflict", async () => {
		const { rerender } = renderTab(makeCollection([extractElement("e1")]));

		fireEvent.click(screen.getByRole("switch", { name: /enable extract json/i }));

		const external = [{ ...extractElement("e1"), enabled: true }, extractElement("e2")];
		rerender(<ElementsTab collection={makeCollection(external)} />);
		expect(screen.getByText(/changed elsewhere/i)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /take theirs/i }));

		expect(screen.queryByText(/changed elsewhere/i)).not.toBeInTheDocument();
		expect(screen.getAllByText("Extract JSON")).toHaveLength(2);
	});

	it("a clean tab still adopts an external write immediately, as before", () => {
		const { rerender } = renderTab(makeCollection([extractElement("e1")]));

		rerender(
			<ElementsTab
				collection={makeCollection([extractElement("e1"), extractElement("e2")])}
			/>
		);

		expect(screen.getAllByText("Extract JSON")).toHaveLength(2);
		expect(screen.queryByText(/changed elsewhere/i)).not.toBeInTheDocument();
	});
});

// Issue #1553: the "Names mentioned" row, ported to sit above a script
// element's own editor via ElementList's `renderAboveForm`, reading this
// tab's own `useDataContract`/`useVariableResolver` answers - which
// `ScriptElementForm` itself structurally cannot do (see that file's doc
// comment).
describe("ElementsTab - the Names-mentioned row (issue #1553)", () => {
	it("shows above a script.pre element's editor, reading this tab's own context", () => {
		allVariables.value = { token: { value: "abc", scope: "environment" } };
		renderTab(
			makeCollection([scriptElement("e1", "script.pre", 'pm.environment.get("token");')])
		);

		expect(screen.getByText("Names mentioned:")).toBeInTheDocument();
		expect(screen.getByText("token")).toBeInTheDocument();
	});

	it("shows above a script.post element's editor too", () => {
		renderTab(
			makeCollection([scriptElement("e1", "script.post", 'const u = "{{base_url}}";')])
		);

		expect(screen.getByText("Names mentioned:")).toBeInTheDocument();
		expect(screen.getByText("{{base_url}}")).toBeInTheDocument();
	});

	it("does not show for a non-script element", () => {
		renderTab(makeCollection([extractElement("e1")]));

		expect(screen.queryByText("Names mentioned:")).not.toBeInTheDocument();
	});

	it("paints a declared data column against this collection's own contract", () => {
		dataContract.value = { collectionId: "c1", collectionName: "Acme API", columns: ["email"] };
		renderTab(
			makeCollection([scriptElement("e1", "script.pre", 'const e = "{{data.email}}";')])
		);

		const chip = screen.getByText("data.email");
		expect(chip.getAttribute("title")).toContain("declared in Acme API");
	});
});
