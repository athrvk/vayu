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
 * `ElementList` (issue #1512, issue #1516's own stated test plan names this
 * file explicitly) - the shared primitive both the request builder's Elements
 * tab and the collection detail's bind to their own `elements` array.
 *
 * The extensibility contract is the point of the whole cut: a kind the app
 * has never seen (no bespoke form in `elementForms.ts`) must still be
 * editable, through the schema-driven `GenericElementForm`. Mutation check for
 * that claim: if `GenericElementForm`'s schema-driven branch were removed (or
 * `ElementRow` stopped falling through to it for an unknown kind), the first
 * case below - a kind with no override, asserting its schema's own property
 * label renders - would redden, because nothing would print that label at
 * all. The unknown-kind case is the one CLAUDE.md's "written but never read"
 * warning is about: a form only the generic renderer can produce.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ElementDef, ElementKindSchema } from "@/types";
import { ElementList } from "./index";

// The snippets list under a script element's editor reads the engine's
// completion table; not what this file guards.
vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

// Monaco does not run under jsdom.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: (props: {
		ariaLabel?: string;
		value: string;
		onChange?: (value: string | undefined) => void;
	}) => (
		<textarea
			data-testid="code-editor"
			aria-label={props.ariaLabel}
			value={props.value}
			onChange={(e) => props.onChange?.(e.target.value)}
		/>
	),
}));

function kindSchema(overrides: Partial<ElementKindSchema> & { kind: string }): ElementKindSchema {
	return {
		version: 1,
		label: overrides.kind,
		description: `${overrides.kind} description`,
		category: "test",
		hotPathClass: "declarative",
		configSchema: { type: "object", properties: {} },
		phases: [],
		...overrides,
	};
}

/** A kind with no bespoke form: the generic renderer is its only editor. */
const EXTRACT_KIND = kindSchema({
	kind: "extract.json",
	label: "Extract JSON",
	category: "extract",
	configSchema: {
		type: "object",
		properties: {
			path: { type: "string" },
		},
	},
});

const ASSERT_KIND = kindSchema({
	kind: "assert.status",
	label: "Assert Status",
	category: "assert",
});

const SCRIPT_KIND = kindSchema({
	kind: "script.pre",
	label: "Pre-request Script",
	category: "script",
});

/** Consumed by the engine at compose time, never offered as a row to add by hand. */
const INHERIT_DISABLE_KIND = kindSchema({
	kind: "inherit.disable",
	label: "Inherited element disabled",
	category: "extract",
});

const KINDS: ElementKindSchema[] = [EXTRACT_KIND, ASSERT_KIND, SCRIPT_KIND, INHERIT_DISABLE_KIND];

function extractElement(id: string, path = ""): ElementDef {
	return { id, kind: "extract.json", enabled: true, config: { path } };
}

function assertElement(id: string): ElementDef {
	return { id, kind: "assert.status", enabled: true, config: {} };
}

function scriptElement(id: string, script = ""): ElementDef {
	return { id, kind: "script.pre", enabled: true, config: { script } };
}

function renderList(elements: ElementDef[], onChange = vi.fn()) {
	render(<ElementList elements={elements} onChange={onChange} kinds={KINDS} />);
	return onChange;
}

describe("ElementList - the generic form for a kind with no bespoke override", () => {
	it("renders a schema-driven field, labeled from the kind's own configSchema", () => {
		renderList([extractElement("e1")]);

		// `path` comes only from EXTRACT_KIND's configSchema.properties - no
		// component in this file hardcodes it. If the fallback to
		// GenericElementForm were removed, this kind (no ELEMENT_FORM_OVERRIDES
		// entry) would render nothing here at all.
		expect(screen.getByText("path")).toBeInTheDocument();
	});

	it("edits the schema-driven field through onChange, not a bespoke handler", () => {
		const onChange = renderList([extractElement("e1")]);

		// Two textboxes exist on any row - the row's own optional-name field,
		// then the schema-driven `path` field the generic form renders.
		const textboxes = screen.getAllByRole("textbox");
		expect(textboxes).toHaveLength(2);
		fireEvent.change(textboxes[1], { target: { value: "$.data.id" } });

		expect(onChange).toHaveBeenCalledWith([extractElement("e1", "$.data.id")]);
	});

	it("says plainly when a kind's schema declares no configuration at all", () => {
		renderList([assertElement("a1")]);

		expect(screen.getByText(/takes no configuration/i)).toBeInTheDocument();
	});
});

describe("ElementList - the bespoke form for script.pre", () => {
	it("renders ScriptElementForm's editor instead of a generic text field", () => {
		renderList([scriptElement("s1", "pm.test('ok', () => {});")]);

		expect(screen.getByTestId("code-editor")).toHaveValue("pm.test('ok', () => {});");
		// SCRIPT_KIND's fixture schema declares no properties - if the bespoke
		// override were missing (or `elementForms.ts` stopped mapping
		// `script.pre`), `GenericElementForm` would render this message instead
		// of the editor above.
		expect(screen.queryByText(/takes no configuration/i)).not.toBeInTheDocument();
	});

	it("edits the script through the bespoke form's own onChange", () => {
		const onChange = renderList([scriptElement("s1", "")]);

		fireEvent.change(screen.getByTestId("code-editor"), { target: { value: "pm.test();" } });

		expect(onChange).toHaveBeenCalledWith([scriptElement("s1", "pm.test();")]);
	});
});

describe("ElementList - the Add menu", () => {
	function openMenu() {
		fireEvent.pointerDown(screen.getByRole("button", { name: /add element/i }), { button: 0 });
	}

	it("groups the catalogue by category", async () => {
		renderList([]);
		openMenu();

		expect(await screen.findByText("extract")).toBeInTheDocument();
		expect(screen.getByText("assert")).toBeInTheDocument();
		expect(screen.getByText("script")).toBeInTheDocument();
	});

	it("excludes inherit.disable from the menu, per the component's own comment", async () => {
		renderList([]);
		openMenu();

		await screen.findByRole("menuitem", { name: "Extract JSON" });
		expect(
			screen.queryByRole("menuitem", { name: /inherited element disabled/i })
		).not.toBeInTheDocument();
	});

	it("adds a new, enabled element of the picked kind", async () => {
		const onChange = renderList([]);
		openMenu();

		fireEvent.click(await screen.findByRole("menuitem", { name: "Assert Status" }));

		expect(onChange).toHaveBeenCalledTimes(1);
		const added = (onChange.mock.calls[0][0] as ElementDef[])[0];
		expect(added.kind).toBe("assert.status");
		expect(added.enabled).toBe(true);
		expect(added.config).toEqual({});
		expect(typeof added.id).toBe("string");
		expect(added.id.length).toBeGreaterThan(0);
	});
});

describe("ElementList - enabling and deleting a row", () => {
	it("toggles enabled off through onChange, keeping everything else the same", () => {
		const onChange = renderList([extractElement("e1")]);

		fireEvent.click(screen.getByRole("switch", { name: /enable extract json/i }));

		expect(onChange).toHaveBeenCalledWith([{ ...extractElement("e1"), enabled: false }]);
	});

	it("dims a disabled row", () => {
		renderList([{ ...extractElement("e1"), enabled: false }]);

		const row = screen.getByText("Extract JSON").closest("[data-element-row]");
		expect(row?.className).toContain("opacity-60");
	});

	it("removes exactly the deleted element, keeping the rest", () => {
		const onChange = renderList([extractElement("e1"), assertElement("a1")]);

		fireEvent.click(screen.getByRole("button", { name: /delete extract json/i }));

		expect(onChange).toHaveBeenCalledWith([assertElement("a1")]);
	});
});

describe("ElementList - reordering", () => {
	it("swaps two adjacent elements when the second is moved up", () => {
		const onChange = renderList([extractElement("e1"), assertElement("a1")]);

		fireEvent.click(screen.getAllByRole("button", { name: /move element up/i })[1]);

		expect(onChange).toHaveBeenCalledWith([assertElement("a1"), extractElement("e1")]);
	});

	it("swaps two adjacent elements when the first is moved down", () => {
		const onChange = renderList([extractElement("e1"), assertElement("a1")]);

		fireEvent.click(screen.getAllByRole("button", { name: /move element down/i })[0]);

		expect(onChange).toHaveBeenCalledWith([assertElement("a1"), extractElement("e1")]);
	});

	it("disables moving the first row up and the last row down", () => {
		renderList([extractElement("e1"), assertElement("a1")]);

		const ups = screen.getAllByRole("button", { name: /move element up/i });
		const downs = screen.getAllByRole("button", { name: /move element down/i });

		expect(ups[0]).toBeDisabled();
		expect(downs[downs.length - 1]).toBeDisabled();
		expect(ups[ups.length - 1]).not.toBeDisabled();
		expect(downs[0]).not.toBeDisabled();
	});
});

describe("ElementList - empty state", () => {
	it("shows the caller's empty label only when there are no elements", () => {
		render(
			<ElementList
				elements={[]}
				onChange={vi.fn()}
				kinds={KINDS}
				emptyLabel="Nothing here yet."
			/>
		);

		expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
	});

	it("hides the empty label once an element exists", () => {
		render(
			<ElementList
				elements={[extractElement("e1")]}
				onChange={vi.fn()}
				kinds={KINDS}
				emptyLabel="Nothing here yet."
			/>
		);

		expect(screen.queryByText("Nothing here yet.")).not.toBeInTheDocument();
	});
});
