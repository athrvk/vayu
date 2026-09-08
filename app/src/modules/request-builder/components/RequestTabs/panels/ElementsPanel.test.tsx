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
 * ElementsPanel (issue #1512) - the request builder's one Elements tab,
 * replacing the separate Pre-request and Tests tabs.
 *
 * What is pinned here is the wiring, not any one child's own behaviour (each
 * has its own suite: `InheritedElementsNotice.test.tsx`, `LegacyScriptNotice`
 * is covered via `DesignRunView.test.tsx`, `ElementList.test.tsx`) - that the
 * panel binds `ElementList` to `request.elements` / `updateField("elements", ...)`,
 * shows the chain's contribution above it, and keeps the legacy notice for a
 * run recorded before script parts existed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { RequestBuilderContextValue } from "../../../types";
import type { ElementDef, ElementKindSchema } from "@/types";

/** A minimal catalogue entry - only what `ElementList` and its forms read. */
function kindSchema(
	kind: string,
	label: string,
	category = "test",
	collectionOnly = false
): ElementKindSchema {
	return {
		kind,
		version: 1,
		label,
		description: `${label} description`,
		category,
		hotPathClass: "declarative",
		collectionOnly,
		configSchema: { type: "object", properties: {} },
		phases: [],
	};
}

const KINDS: ElementKindSchema[] = [
	kindSchema("extract.json", "Extract JSON", "extract"),
	kindSchema("assert.status", "Assert Status", "assert"),
	kindSchema("script.pre", "Pre-request Script", "script"),
	kindSchema("script.post", "Test Script", "script"),
	// script.setup / script.teardown (issue #1499): collection-only, so a
	// request's own Add menu must never offer them.
	kindSchema("script.setup", "Setup Script", "script", /* collectionOnly */ true),
];

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useElementKindsQuery: () => ({ data: KINDS }),
	// ScriptElementForm's snippets list reads this; not what this file guards.
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

vi.mock("@/queries/collections", () => ({
	useCollectionAncestors: () => [],
}));

// Monaco does not run under jsdom.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const updateField = vi.fn();

let ctx: Partial<RequestBuilderContextValue> = {};

vi.mock("../../../context", () => ({
	useRequestBuilderContext: () => ctx,
}));

const { default: ElementsPanel } = await import("./ElementsPanel");

function extractElement(id: string): ElementDef {
	return { id, kind: "extract.json", enabled: true, config: {} };
}

function scriptElement(id: string, kind: "script.pre" | "script.post", script: string): ElementDef {
	return { id, kind, enabled: true, config: { script } };
}

function setContext(overrides: Partial<RequestBuilderContextValue> = {}) {
	ctx = {
		request: { id: "req_1", collectionId: null, elements: [] } as never,
		updateField,
		inheritedElements: undefined,
		legacyPreScript: undefined,
		legacyPostScript: undefined,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		dataColumns: undefined,
		...overrides,
	};
}

beforeEach(() => {
	updateField.mockClear();
	setContext();
});

describe("ElementsPanel", () => {
	it("renders the request's own elements through ElementList", () => {
		setContext({
			request: { id: "req_1", collectionId: null, elements: [extractElement("e1")] } as never,
		});

		render(<ElementsPanel />);

		expect(screen.getByText("Extract JSON")).toBeInTheDocument();
	});

	it("renders the inherited-elements notice above the list", () => {
		setContext({
			inheritedElements: [
				{
					id: "c1",
					kind: "extract.json",
					enabled: true,
					config: {},
					origin: { kind: "collection", id: "col_1", name: "Acme" },
				},
			],
		});

		render(<ElementsPanel />);

		expect(screen.getByText(/runs before your own/i)).toBeInTheDocument();
		expect(screen.getByText("Acme")).toBeInTheDocument();
	});

	it("shows both legacy script notices when the run recorded pre-parts scripts", () => {
		setContext({
			legacyPreScript: "recorded_pre_marker",
			legacyPostScript: "recorded_post_marker",
		});

		render(<ElementsPanel />);

		expect(screen.getByText(/recorded_pre_marker/)).toBeInTheDocument();
		expect(screen.getByText(/recorded_post_marker/)).toBeInTheDocument();
	});

	it("shows neither legacy notice for an ordinary request", () => {
		setContext();

		render(<ElementsPanel />);

		expect(screen.queryByText(/cannot be separated/i)).not.toBeInTheDocument();
	});

	it('calls updateField("elements", ...) when an element is added from the menu', async () => {
		setContext();

		render(<ElementsPanel />);

		// `ElementList`'s Add-element menu is an uncontrolled DropdownMenu, so
		// Radix's own trigger handles opening it - on `pointerdown`, not on
		// `click` (unlike `RowActionsMenu`, which layers a click handler over
		// Radix's for a keyboard-dispatched `.click()`).
		fireEvent.pointerDown(screen.getByRole("button", { name: /add element/i }), {
			button: 0,
		});
		fireEvent.click(await screen.findByRole("menuitem", { name: /extract json/i }));

		expect(updateField).toHaveBeenCalledWith(
			"elements",
			expect.arrayContaining([expect.objectContaining({ kind: "extract.json" })])
		);
	});

	// Mutation check: drop the `!kind.collectionOnly` filter in ElementsPanel
	// and this reddens - "Setup Script" would appear beside the others.
	it("hides a collection-only kind from the Add-element menu", async () => {
		setContext();

		render(<ElementsPanel />);

		fireEvent.pointerDown(screen.getByRole("button", { name: /add element/i }), {
			button: 0,
		});
		await screen.findByRole("menuitem", { name: /extract json/i });

		expect(screen.queryByRole("menuitem", { name: /setup script/i })).not.toBeInTheDocument();
	});

	it('calls updateField("elements", ...) when an existing element is toggled off', () => {
		setContext({
			request: { id: "req_1", collectionId: null, elements: [extractElement("e1")] } as never,
		});

		render(<ElementsPanel />);

		fireEvent.click(screen.getByRole("switch", { name: /enable extract json/i }));

		expect(updateField).toHaveBeenCalledWith("elements", [
			{ id: "e1", kind: "extract.json", enabled: false, config: {} },
		]);
	});

	it('calls updateField("elements", ...) when an element is deleted', () => {
		setContext({
			request: { id: "req_1", collectionId: null, elements: [extractElement("e1")] } as never,
		});

		render(<ElementsPanel />);

		fireEvent.click(screen.getByRole("button", { name: /delete extract json/i }));

		expect(updateField).toHaveBeenCalledWith("elements", []);
	});

	// Issue #1553: the "Names mentioned" row, ported to sit above a script
	// element's own editor via ElementList's `renderAboveForm`, reading this
	// panel's own `useRequestBuilderContext` answers - which `ScriptElementForm`
	// itself structurally cannot do (see that file's doc comment).
	describe("the Names-mentioned row (issue #1553)", () => {
		it("shows above a script.pre element's editor, reading this panel's own context", () => {
			setContext({
				request: {
					id: "req_1",
					collectionId: null,
					elements: [scriptElement("e1", "script.pre", 'pm.environment.get("token");')],
				} as never,
				getAllVariables: () => ({ token: { value: "abc", scope: "environment" } }),
			});

			render(<ElementsPanel />);

			expect(screen.getByText("Names mentioned:")).toBeInTheDocument();
			expect(screen.getByText("token")).toBeInTheDocument();
		});

		it("shows above a script.post element's editor too", () => {
			setContext({
				request: {
					id: "req_1",
					collectionId: null,
					elements: [scriptElement("e1", "script.post", 'const u = "{{base_url}}";')],
				} as never,
			});

			render(<ElementsPanel />);

			expect(screen.getByText("Names mentioned:")).toBeInTheDocument();
			expect(screen.getByText("{{base_url}}")).toBeInTheDocument();
		});

		it("does not show for a non-script element", () => {
			setContext({
				request: {
					id: "req_1",
					collectionId: null,
					elements: [extractElement("e1")],
				} as never,
			});

			render(<ElementsPanel />);

			expect(screen.queryByText("Names mentioned:")).not.toBeInTheDocument();
		});
	});
});
