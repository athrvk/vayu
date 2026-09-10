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
import { render, screen, fireEvent, within } from "@testing-library/react";
import { useLayoutStore } from "@/stores";
import { useEditorVariableTokensContext } from "@/components/shared/EditorVariableTokens/context";
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

/**
 * Issue #1651: `ElementsTab` builds its `VariableSupport`'s write half from
 * `useVariableWriter` now, the same hook `RequestBuilderProvider` uses,
 * rather than the hardcoded `updateVariable: () => {}` / `writableScopes: []`
 * that made every token in this tab's script editors open read-only.
 * `useVariableWriter` itself is a real TanStack Query + Zustand hook with its
 * own suite (`hooks/useVariableWriter.test.ts`); stubbed here at the same
 * `@/hooks` seam as `useDataContract`/`useVariableResolver` above it, both
 * because this file stands up no `QueryClientProvider` and because what this
 * suite guards is the wiring - which `collectionId` this tab passes in - not
 * the hook's own behavior.
 */
const useVariableWriterMock = vi.fn((_opts?: { collectionId?: string }) => ({
	updateVariable: vi.fn(),
	writableScopes: [] as string[],
}));

vi.mock("@/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks")>()),
	useDataContract: () => dataContract.value,
	useVariableResolver: () => ({
		getAllVariables: () => allVariables.value,
		getVariableOrigins: (name: string) => variableOrigins.value[name] ?? [],
	}),
	useVariableWriter: (opts: { collectionId?: string }) => useVariableWriterMock(opts),
}));

function kindSchema(kind: string, label: string, category: string): ElementKindSchema {
	return {
		kind,
		version: 1,
		label,
		description: `${label} description`,
		category,
		hotPathClass: "declarative",
		collectionOnly: false,
		configSchema: { type: "object", properties: {} },
		phases: [],
	};
}

/** A kind with a required config field, for the incompleteness cases (#1635). */
const REQUIRED_KIND: ElementKindSchema = {
	kind: "extract.required",
	version: 1,
	label: "Extract Required",
	description: "Extract Required description",
	category: "extract",
	hotPathClass: "declarative",
	collectionOnly: false,
	configSchema: {
		type: "object",
		required: ["variable"],
		properties: { variable: { type: "string", title: "Variable name" } },
	},
	phases: [],
};

const KINDS: ElementKindSchema[] = [
	kindSchema("extract.json", "Extract JSON", "extract"),
	kindSchema("assert.status", "Assert Status", "assert"),
	kindSchema("script.pre", "Pre-request Script", "script"),
	kindSchema("script.post", "Test Script", "script"),
	REQUIRED_KIND,
];

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useElementKindsQuery: () => ({ data: KINDS }),
	// ScriptElementForm's snippets list reads this; not what this file guards.
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

// Monaco does not run under jsdom. The stand-in reads the real
// `EditorVariableTokensContext` (not mocked) so the mount test below can prove
// `ElementsTab` wraps its editors in the provider without needing Monaco at all.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => {
		const tokens = useEditorVariableTokensContext();
		return (
			<div data-testid="code-editor" data-has-token-provider={tokens ? "true" : "false"} />
		);
	},
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
	fireEvent.click(screen.getByRole("button", { name: /add element/i }));
}

/** A card's own root, from any text rendered inside its header or body. */
function rowFor(text: string | RegExp): HTMLElement {
	return screen.getByText(text).closest("[data-element-row]") as HTMLElement;
}

/** Expands a card by its title, so its body (the form, `renderAboveForm`) renders. */
function expandRow(title: string) {
	fireEvent.click(within(rowFor(title)).getByRole("button", { name: `Expand ${title}` }));
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
	useVariableWriterMock.mockClear();
	// `ElementList`'s Add-element picker reads/writes this directly - reset so
	// one test's pick does not surface as a duplicate "Recently used" row
	// in the next.
	useLayoutStore.setState({ recentElementKinds: [] });
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
		fireEvent.click((await screen.findByText("Extract JSON")).closest("[cmdk-item]")!);

		expect(save).toBeEnabled();
	});

	it("is disabled again once Reset discards the draft", async () => {
		renderTab(makeCollection([]));

		openAddMenu();
		fireEvent.click((await screen.findByText("Extract JSON")).closest("[cmdk-item]")!);
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

describe("ElementsTab - a required field an element's config is missing (issue #1635)", () => {
	async function addRequiredElement() {
		openAddMenu();
		fireEvent.click((await screen.findByText("Extract Required")).closest("[cmdk-item]")!);
	}

	it("stays disabled (not merely undirtied) once an incomplete element makes the draft dirty", async () => {
		renderTab(makeCollection([]));
		await addRequiredElement();

		// The picker's own add is what makes the draft dirty - a plain `!isDirty`
		// check would already disable this button, so this case is only proof of
		// the incompleteness guard if it stays disabled *while* dirty.
		expect(screen.getByText("Extract Required")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /save elements/i })).toBeDisabled();
	});

	it("names the field on the row itself", async () => {
		renderTab(makeCollection([]));
		await addRequiredElement();

		expect(screen.getByText("Needs Variable name")).toBeInTheDocument();
	});

	it("re-enables Save Elements once the field is filled in", async () => {
		renderTab(makeCollection([]));
		await addRequiredElement();
		expect(screen.getByRole("button", { name: /save elements/i })).toBeDisabled();

		const textboxes = screen.getAllByRole("textbox");
		fireEvent.change(textboxes[textboxes.length - 1], {
			target: { value: "token" },
		});

		expect(screen.getByRole("button", { name: /save elements/i })).toBeEnabled();
		expect(screen.queryByText(/^Needs /)).not.toBeInTheDocument();
	});

	it("never calls the update mutation while an element is incomplete, even via a direct click", async () => {
		renderTab(makeCollection([]));
		await addRequiredElement();

		// Disabled buttons refuse a real click too - this pins the same guard
		// `persist` carries for Cmd+S and the quit flush, which do not read the
		// disabled attribute at all.
		fireEvent.click(screen.getByRole("button", { name: /save elements/i }));

		expect(mutation.mutateAsync).not.toHaveBeenCalled();
	});

	it("says why saving is held back", async () => {
		renderTab(makeCollection([]));
		await addRequiredElement();

		expect(screen.getByText(/finish the field/i)).toBeInTheDocument();
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
		expandRow("Pre-request Script");

		expect(screen.getByText("Names mentioned:")).toBeInTheDocument();
		expect(screen.getByText("token")).toBeInTheDocument();
	});

	it("shows above a script.post element's editor too", () => {
		renderTab(
			makeCollection([scriptElement("e1", "script.post", 'const u = "{{base_url}}";')])
		);
		expandRow("Test Script");

		expect(screen.getByText("Names mentioned:")).toBeInTheDocument();
		expect(screen.getByText("{{base_url}}")).toBeInTheDocument();
	});

	it("does not show for a non-script element", () => {
		renderTab(makeCollection([extractElement("e1")]));
		expandRow("Extract JSON");

		expect(screen.queryByText("Names mentioned:")).not.toBeInTheDocument();
	});

	it("paints a declared data column against this collection's own contract", () => {
		dataContract.value = { collectionId: "c1", collectionName: "Acme API", columns: ["email"] };
		renderTab(
			makeCollection([scriptElement("e1", "script.pre", 'const e = "{{data.email}}";')])
		);
		expandRow("Pre-request Script");

		const chip = screen.getByText("data.email");
		expect(chip.getAttribute("title")).toContain("declared in Acme API");
	});
});

/**
 * Issue #1220 script support: the collection's script elements had the
 * "Names mentioned" summary above their editor, but the editor itself painted
 * no `{{token}}` at all - `EditorVariableTokensProvider` was never mounted
 * here, unlike `RequestBuilderProvider`'s own tree. Monaco does not run under
 * jsdom (`CodeEditor` above is a stand-in), so this is a mount test: it reads
 * `useEditorVariableTokensContext()` from inside the mocked editor and asserts
 * a provider is somewhere above it, rather than asserting a painted class.
 *
 * Mutation check: remove `ElementsTab`'s `<EditorVariableTokensProvider>` wrap
 * and this reds (`data-has-token-provider="false"`); put it back and it's
 * green.
 */
describe("ElementsTab - the token-editing provider (issue #1220 script support)", () => {
	it("wraps the element list's editors in EditorVariableTokensProvider", () => {
		renderTab(
			makeCollection([scriptElement("e1", "script.pre", 'pm.environment.get("token");')])
		);
		expandRow("Pre-request Script");

		expect(screen.getByTestId("code-editor")).toHaveAttribute(
			"data-has-token-provider",
			"true"
		);
	});
});

/**
 * Issue #1651: a token's popover used to open read-only in this tab no matter
 * what - `variableSupport` hardcoded `updateVariable: () => {}` and
 * `writableScopes: []` rather than reading them from anywhere. Now it reads
 * them from `useVariableWriter`, the same hook `RequestBuilderProvider` uses,
 * so a script element here can write global/collection/environment variables
 * on the same terms a request's own script can.
 *
 * Mutation check: hardcode `variableSupport`'s `updateVariable`/`writableScopes`
 * back to `() => {}`/`[]` and this reds - `useVariableWriterMock` is called
 * with nothing at all, so the second assertion below (the id it was asked
 * for) fails first.
 */
describe("ElementsTab - the variable writer (issue #1651)", () => {
	it("builds its VariableSupport's write half from useVariableWriter, scoped to this collection", () => {
		renderTab(makeCollection([]));

		expect(useVariableWriterMock).toHaveBeenCalledWith({ collectionId: "c1" });
	});
});
