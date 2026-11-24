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
import { screen, fireEvent, within, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { useLayoutStore, useTabSelectionStore } from "@/stores";
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

/** A kind whose `text` the engine resolves `{{tokens}}` in (#3779): the list must hand its form the scope. */
const CONTAINS_KIND: ElementKindSchema = {
	...kindSchema("assert.contains", "Assert text", "assert"),
	configSchema: {
		type: "object",
		properties: { text: { type: "string", title: "Text" } },
	},
};

const KINDS: ElementKindSchema[] = [
	CONTAINS_KIND,
	kindSchema("extract.json", "Extract JSON", "extract"),
	kindSchema("assert.status", "Assert Status", "assert"),
	kindSchema("assert.jsonschema", "Assert JSON Schema", "assert"),
	kindSchema("assert.snapshot", "Assert list snapshot", "assert"),
	kindSchema("script.pre", "Pre-request script", "script"),
	kindSchema("script.post", "Test Script", "script"),
	// script.setup / script.teardown (issue #1499): collection-only, so a
	// request's own Add menu must never offer them.
	kindSchema("script.setup", "Setup Script", "script", /* collectionOnly */ true),
];

/** What `useRequestQuery` answers: the saved row, undefined while it loads or for an unsaved request. */
const savedRequest: { value: { id: string; name: string } | undefined } = { value: undefined };

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useElementKindsQuery: () => ({ data: KINDS }),
	useRequestQuery: () => ({ data: savedRequest.value }),
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

// Both paths: the panel takes the hook from the module index, and
// `useVariableSupport` from the file behind it.
vi.mock("../../../context", () => ({
	useRequestBuilderContext: () => ctx,
}));
vi.mock("../../../context/RequestBuilderContext", () => ({
	useRequestBuilderContext: () => ctx,
}));

const { default: ElementsPanel } = await import("./ElementsPanel");

function extractElement(id: string): ElementDef {
	return { id, kind: "extract.json", enabled: true, config: {} };
}

function scriptElement(id: string, kind: "script.pre" | "script.post", script: string): ElementDef {
	return { id, kind, enabled: true, config: { script } };
}

/** A card's own root, from any text rendered inside its header or body. */
function rowFor(text: string | RegExp): HTMLElement {
	return screen.getByText(text).closest("[data-element-row]") as HTMLElement;
}

/** Expands a card by its title, so its body (the form, `renderAboveForm`) renders. */
function expandRow(title: string) {
	fireEvent.click(within(rowFor(title)).getByRole("button", { name: `Expand ${title}` }));
}

/**
 * Opens a card's `⋯` menu and clicks the named action - see
 * `ElementList.test.tsx`'s own `chooseRowAction` for why each step is what
 * it is (`pointerdown`+`click` to open, waiting for the menu's own node to
 * actually leave the document before returning).
 */
async function chooseRowAction(title: string, action: string) {
	const trigger = within(rowFor(title)).getByRole("button", {
		name: `More actions for ${title}`,
	});
	fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
	fireEvent.click(trigger, { detail: 1 });
	const menu = await screen.findByRole("menu");
	fireEvent.click(await screen.findByRole("menuitem", { name: action }));
	await waitFor(() => expect(menu.isConnected).toBe(false));
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
	savedRequest.value = undefined;
	setContext();
	// `ElementList`'s Add-element picker reads/writes this directly - reset so
	// one test's pick does not surface as a duplicate "Recently used" row
	// in the next.
	useLayoutStore.setState({ recentElementKinds: [] });
	// Every case shares request id `req_1`, and which rows are open is kept per
	// id in this store - one case's expanded row must not open the next one's.
	useTabSelectionStore.getState().clearAll();
});

describe("ElementsPanel", () => {
	it("renders the request's own elements through ElementList", () => {
		setContext({
			request: { id: "req_1", collectionId: null, elements: [extractElement("e1")] } as never,
		});

		render(<ElementsPanel />);

		expect(screen.getByText("Extract JSON")).toBeInTheDocument();
	});

	// Mutation check: drop `variables={variables}` from `ElementsPanel`'s
	// `<ElementList>` and the overlay is gone, leaving a plain text box.
	it("gives a resolved field the request's variable scope (#3779)", () => {
		setContext({
			request: {
				id: "req_1",
				collectionId: null,
				elements: [
					{
						id: "c1",
						kind: "assert.contains",
						enabled: true,
						config: { text: "{{data.email}}" },
					},
				],
			} as never,
		});

		render(<ElementsPanel />);
		expandRow("Assert text");

		expect(document.querySelector("[data-variable-overlay]")?.textContent).toContain(
			"{{data.email}}"
		);
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

		// `ElementList`'s Add-element control is a `Popover` holding a `Command`
		// (issue #1604) - it opens on the trigger button's ordinary `click`.
		fireEvent.click(screen.getByRole("button", { name: /add element/i }));
		fireEvent.click((await screen.findByText("Extract JSON")).closest("[cmdk-item]")!);

		expect(updateField).toHaveBeenCalledWith(
			"elements",
			expect.arrayContaining([expect.objectContaining({ kind: "extract.json" })])
		);
	});

	// #3806: the element is stored data, so the default is in its `config` the
	// moment it is added. Mutation check: drop `startingConfigs` from
	// `ElementsPanel`'s `<ElementList>` and the first case reds, its `config`
	// `{}` - the tool's schema never reaches `config.schema`.
	describe("an assert.jsonschema added to a request (#3806)", () => {
		const outputSchema = { type: "object", properties: { rows: { type: "array" } } };

		async function addJsonSchemaElement(request: Record<string, unknown>) {
			setContext({
				request: { id: "req_1", collectionId: null, elements: [], ...request } as never,
			});
			render(<ElementsPanel />);
			fireEvent.click(screen.getByRole("button", { name: /add element/i }));
			fireEvent.click(
				(await screen.findByText("Assert JSON Schema")).closest("[cmdk-item]")!
			);
			return updateField.mock.lastCall?.[1] as ElementDef[];
		}

		it("starts from the mcp tool's outputSchema, read from the result's structuredContent", async () => {
			const [added] = await addJsonSchemaElement({
				bodyMode: "mcp",
				mcpTool: { name: "run_query", outputSchema },
			});

			expect(added.kind).toBe("assert.jsonschema");
			expect(added.config).toEqual({
				source: "jsonpath",
				path: "$.result.structuredContent",
				schema: outputSchema,
			});
		});

		it.each([
			["a tool with no outputSchema", { bodyMode: "mcp", mcpTool: { name: "t" } }],
			["a json body", { bodyMode: "json", mcpTool: { name: "t", outputSchema } }],
		])("starts blank for %s", async (_name, request) => {
			const [added] = await addJsonSchemaElement(request);

			expect(added.config).toEqual({});
		});
	});

	// #3807: the baseline is recorded from the builder's own response and written
	// through the list's `updateField("elements", ...)`, as a typed edit is.
	describe("an assert.snapshot's Use the current reply as the baseline (#3807)", () => {
		const TOOLS = [
			{ name: "search", inputSchema: { type: "object" } },
			{ name: "fetch", inputSchema: { type: "object" } },
		];
		const BUTTON = "Use the current reply as the baseline";

		function snapshotElement(config: Record<string, unknown>): ElementDef {
			return { id: "s1", kind: "assert.snapshot", enabled: true, config };
		}

		function renderSnapshotRow(config: Record<string, unknown>, body?: string) {
			setContext({
				request: {
					id: "req_1",
					collectionId: null,
					elements: [extractElement("e1"), snapshotElement(config), extractElement("e2")],
				} as never,
				response: body === undefined ? null : ({ body } as never),
			});
			render(<ElementsPanel />);
			expandRow("Assert list snapshot");
		}

		// Mutation check: drop `baseline` from `recordBaseline`'s spread and the
		// element's config comes back without it, so the first expectation reds.
		it("writes the reply's list into the element and leaves the other elements alone", () => {
			renderSnapshotRow(
				{ method: "tools/list" },
				JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: TOOLS } })
			);

			fireEvent.click(screen.getByRole("button", { name: BUTTON }));

			const written = updateField.mock.lastCall?.[1] as ElementDef[];
			expect(updateField.mock.lastCall?.[0]).toBe("elements");
			expect(written.map((el) => el.id)).toEqual(["e1", "s1", "e2"]);
			expect(written[1].config).toEqual({ method: "tools/list", baseline: TOOLS });
			expect(written[0].config).toEqual({});
		});

		it("reads the list the element's own method names", () => {
			renderSnapshotRow(
				{ method: "prompts/list" },
				JSON.stringify({
					result: { tools: TOOLS, prompts: [{ name: "summarise" }] },
				})
			);

			fireEvent.click(screen.getByRole("button", { name: BUTTON }));

			expect((updateField.mock.lastCall?.[1] as ElementDef[])[1].config.baseline).toEqual([
				{ name: "summarise" },
			]);
		});

		it("is disabled, and says why, before anything was sent", async () => {
			renderSnapshotRow({});

			expect(screen.getByRole("button", { name: BUTTON })).toBeDisabled();
			fireEvent.focus(document.querySelector('[data-slot="disabled-hint"]')!);
			expect((await screen.findAllByText(/Send the request first/)).length).toBeGreaterThan(
				0
			);
		});

		it("is disabled when the reply holds no such list", async () => {
			renderSnapshotRow(
				{ method: "resources/list" },
				JSON.stringify({ result: { tools: TOOLS } })
			);

			expect(screen.getByRole("button", { name: BUTTON })).toBeDisabled();
			fireEvent.focus(document.querySelector('[data-slot="disabled-hint"]')!);
			expect((await screen.findAllByText(/holds no resources list/)).length).toBeGreaterThan(
				0
			);
			fireEvent.click(screen.getByRole("button", { name: BUTTON }));
			expect(updateField).not.toHaveBeenCalled();
		});
	});

	// Mutation check: drop the `!kind.collectionOnly` filter in ElementsPanel
	// and this reddens - "Setup Script" would appear beside the others.
	it("hides a collection-only kind from the Add-element menu", async () => {
		setContext();

		render(<ElementsPanel />);

		fireEvent.click(screen.getByRole("button", { name: /add element/i }));
		await screen.findByText("Extract JSON");

		expect(screen.queryByText("Setup Script")).not.toBeInTheDocument();
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

	it('calls updateField("elements", ...) when an element is deleted', async () => {
		setContext({
			request: { id: "req_1", collectionId: null, elements: [extractElement("e1")] } as never,
		});

		render(<ElementsPanel />);

		// `extractElement`'s config is `{}` - blank, so the menu's Delete asks
		// nothing and removes it straight away.
		await chooseRowAction("Extract JSON", "Delete");

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
			expandRow("Pre-request script");

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
			expandRow("Test Script");

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
			expandRow("Extract JSON");

			expect(screen.queryByText("Names mentioned:")).not.toBeInTheDocument();
		});
	});
});

describe("ElementsPanel - Copy for agent", () => {
	const writeText = vi.fn();

	beforeEach(() => {
		writeText.mockReset().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		setContext({
			request: { id: "req_1", collectionId: null, elements: [extractElement("e1")] } as never,
		});
	});

	async function openMenu() {
		const trigger = within(rowFor("Extract JSON")).getByRole("button", {
			name: "More actions for Extract JSON",
		});
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
		fireEvent.click(trigger, { detail: 1 });
		return screen.findByRole("menu");
	}

	it("names the saved request, not the builder's draft", async () => {
		savedRequest.value = { id: "req_1", name: "List pets" };
		render(<ElementsPanel />);

		await openMenu();
		fireEvent.click(await screen.findByRole("menuitem", { name: /Copy for agent/ }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith(
			'Vayu element "extract.json" (e1) of request "List pets" (req_1)'
		);
	});

	it("is absent while there is no saved request to name", async () => {
		render(<ElementsPanel />);

		const menu = await openMenu();

		expect(within(menu).getByRole("menuitem", { name: "Duplicate" })).toBeInTheDocument();
		expect(within(menu).queryByRole("menuitem", { name: /Copy for agent/ })).toBeNull();
	});
});
