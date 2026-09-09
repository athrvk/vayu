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
 * `ElementList` (issue #1512, reworked into a card list by issue #1608) - the
 * shared primitive both the request builder's Elements tab and the
 * collection detail's bind to their own `elements` array.
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
 *
 * A card starts collapsed unless it was just added or duplicated, so every
 * case that needs a card's body (its form, its bespoke editor) expands it
 * first, through the header's own toggle button.
 */

import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { useLayoutStore } from "@/stores";
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
		collectionOnly: false,
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
			path: { type: "string", title: "JSONPath" },
		},
	},
});

const ASSERT_KIND = kindSchema({
	kind: "assert.status",
	label: "Assert Status",
	category: "assert",
});

/**
 * The kind that genuinely declares no configuration - `control.once` is the
 * one in the live catalogue. Not `assert.status`, which used to stand in for
 * it here: its real schema declares two mutually exclusive strategies, so it
 * routes to `ModeElementForm` (`element-modes.ts`) and would show a mode
 * picker rather than the generic form's "takes no configuration" line.
 */
const ONCE_KIND = kindSchema({
	kind: "control.once",
	label: "Once Only",
	category: "controller",
});

const SCRIPT_KIND = kindSchema({
	kind: "script.pre",
	label: "Pre-request Script",
	category: "script",
	description: "Runs before the request is sent.",
});

/** Consumed by the engine at compose time, never offered as a row to add by hand. */
const INHERIT_DISABLE_KIND = kindSchema({
	kind: "inherit.disable",
	label: "Inherited element disabled",
	category: "extract",
});

const KINDS: ElementKindSchema[] = [
	EXTRACT_KIND,
	ASSERT_KIND,
	ONCE_KIND,
	SCRIPT_KIND,
	INHERIT_DISABLE_KIND,
];

function extractElement(id: string, path = ""): ElementDef {
	return { id, kind: "extract.json", enabled: true, config: { path } };
}

function assertElement(id: string): ElementDef {
	return { id, kind: "assert.status", enabled: true, config: {} };
}

function onceElement(id: string): ElementDef {
	return { id, kind: "control.once", enabled: true, config: {} };
}

function scriptElement(id: string, script = ""): ElementDef {
	return { id, kind: "script.pre", enabled: true, config: { script } };
}

function renderList(elements: ElementDef[], onChange = vi.fn()) {
	render(<ElementList elements={elements} onChange={onChange} kinds={KINDS} />);
	return onChange;
}

/**
 * `ElementList` is controlled - a case that needs to see the DOM *after* an
 * `onChange` (a newly added row rendering expanded) needs a host that
 * actually feeds the new value back in, unlike `renderList`'s bare `vi.fn()`.
 */
function StatefulList({ initial }: { initial: ElementDef[] }) {
	const [elements, setElements] = useState(initial);
	return <ElementList elements={elements} onChange={setElements} kinds={KINDS} />;
}

/** A card's own root, from any text rendered inside its header or body. */
function rowFor(text: string | RegExp): HTMLElement {
	return screen.getByText(text).closest("[data-element-row]") as HTMLElement;
}

/** Expands a card by its title, so its body (the form) renders. */
function expandRow(title: string) {
	fireEvent.click(within(rowFor(title)).getByRole("button", { name: `Expand ${title}` }));
}

/**
 * Opens a card's `⋯` menu and clicks the named action. `pointerDown` then
 * `click({ detail: 1 })`: Radix's trigger opens on `pointerdown`, the same
 * two-event sequence `RowActionsMenu.test.tsx` itself uses - a bare
 * `fireEvent.click` fires neither a real pointer event nor `detail === 0`,
 * so it opens nothing. The menu's content mounts through a portal
 * asynchronously, so the item is awaited with `findByRole`, not `getByRole`.
 *
 * Waits for the menu's own DOM node to actually leave the document
 * afterward, not only for the item click to register: Radix schedules moving
 * focus *into* the just-opened content (`onOpenAutoFocus`) asynchronously,
 * and firing this fast leaves that still pending the moment the item click
 * has already handed focus to Rename's own input - it then arrives late and
 * steals focus right back off it. Its exit transition also keeps the node
 * `aria-hidden` (invisible to a role query) for a moment before actually
 * removing it, so the check reads `isConnected` on the captured node itself
 * rather than asking the accessibility tree whether the role is still there.
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

beforeEach(() => {
	useLayoutStore.setState({ recentElementKinds: [] });
});

describe("ElementList - the generic form for a kind with no bespoke override", () => {
	it("renders a schema-driven field, labeled from the schema's own title", () => {
		renderList([extractElement("e1")]);
		expandRow("Extract JSON");

		// The label comes from `path`'s `title` (issue #1607/#1608), not the raw
		// property key - if `GenericElementForm` regressed to the raw key, or the
		// fallback to it were removed entirely, this would redden either way.
		expect(screen.getByText("JSONPath")).toBeInTheDocument();
		expect(screen.queryByText("path")).not.toBeInTheDocument();
	});

	it("edits the schema-driven field through onChange, not a bespoke handler", () => {
		const onChange = renderList([extractElement("e1")]);
		expandRow("Extract JSON");

		fireEvent.change(screen.getByLabelText("JSONPath"), { target: { value: "$.data.id" } });

		expect(onChange).toHaveBeenCalledWith([extractElement("e1", "$.data.id")]);
	});

	it("says plainly when a kind's schema declares no configuration at all", () => {
		renderList([onceElement("o1")]);
		expandRow("Once Only");

		expect(screen.getByText(/takes no configuration/i)).toBeInTheDocument();
	});
});

describe("ElementList - the bespoke form for script.pre", () => {
	it("renders ScriptElementForm's editor instead of a generic text field", () => {
		renderList([scriptElement("s1", "pm.test('ok', () => {});")]);
		expandRow("Pre-request Script");

		expect(screen.getByTestId("code-editor")).toHaveValue("pm.test('ok', () => {});");
		// SCRIPT_KIND's fixture schema declares no properties - if the bespoke
		// override were missing (or `elementForms.ts` stopped mapping
		// `script.pre`), `GenericElementForm` would render this message instead
		// of the editor above.
		expect(screen.queryByText(/takes no configuration/i)).not.toBeInTheDocument();
	});

	it("shows the kind's own catalogue description as the form's intro, not a hard-coded one", () => {
		renderList([scriptElement("s1")]);
		expandRow("Pre-request Script");

		expect(screen.getByText(SCRIPT_KIND.description)).toBeInTheDocument();
	});

	it("edits the script through the bespoke form's own onChange", () => {
		const onChange = renderList([scriptElement("s1", "")]);
		expandRow("Pre-request Script");

		fireEvent.change(screen.getByTestId("code-editor"), { target: { value: "pm.test();" } });

		expect(onChange).toHaveBeenCalledWith([scriptElement("s1", "pm.test();")]);
	});
});

describe("ElementList - collapse and expand", () => {
	it("starts a pre-existing element collapsed, showing its summary instead of the form", () => {
		renderList([extractElement("e1", "$.token")]);

		expect(screen.queryByLabelText("JSONPath")).not.toBeInTheDocument();
		// `extract.json`'s summary needs a `variable` too - absent here, so this
		// falls back to the kind's own description rather than a half-summary.
		expect(screen.getByText(EXTRACT_KIND.description)).toBeInTheDocument();
	});

	it("expands on a header click and collapses again on a second", () => {
		renderList([extractElement("e1")]);

		expandRow("Extract JSON");
		expect(screen.getByLabelText("JSONPath")).toBeInTheDocument();

		fireEvent.click(
			within(rowFor("Extract JSON")).getByRole("button", { name: "Collapse Extract JSON" })
		);
		expect(screen.queryByLabelText("JSONPath")).not.toBeInTheDocument();
	});

	it("opens a newly added element expanded, not collapsed", async () => {
		render(<StatefulList initial={[]} />);
		fireEvent.click(screen.getByRole("button", { name: /add element/i }));
		await screen.findByText("Once Only");
		fireEvent.click(screen.getByText("Once Only").closest("[cmdk-item]")!);

		expect(screen.getByText(/takes no configuration/i)).toBeInTheDocument();
	});
});

describe("ElementList - the Add menu", () => {
	function openMenu() {
		fireEvent.click(screen.getByRole("button", { name: /add element/i }));
	}

	function optionRow(label: string): HTMLElement {
		return screen.getByText(label).closest("[cmdk-item]") as HTMLElement;
	}

	it("groups the catalogue by category, in family order and title case", async () => {
		renderList([]);
		openMenu();
		await screen.findByText("Extract JSON");

		const headings = screen
			.getAllByText(/^(Extract|Assert|Script)$/)
			.map((el) => el.textContent);
		expect(headings).toEqual(["Extract", "Assert", "Script"]);
	});

	it("shows each item's description on the row, not only on hover", async () => {
		renderList([]);
		openMenu();

		expect(await screen.findByText(EXTRACT_KIND.description)).toBeInTheDocument();
	});

	it("excludes inherit.disable from the menu, per the component's own comment", async () => {
		renderList([]);
		openMenu();

		await screen.findByText("Extract JSON");
		expect(screen.queryByText(/inherited element disabled/i)).not.toBeInTheDocument();
	});

	it("filters to a matching kind by search text", async () => {
		renderList([]);
		openMenu();
		await screen.findByText("Assert Status");

		fireEvent.change(screen.getByPlaceholderText("Search elements"), {
			target: { value: "assert.status" },
		});

		expect(screen.getByText("Assert Status")).toBeInTheDocument();
		expect(screen.queryByText("Extract JSON")).not.toBeInTheDocument();
	});

	// cmdk's default fuzzy scorer treats a query as a scattered subsequence:
	// "regex" matches "a regular expression" too (r-e-g-...-e-x, in order,
	// just not adjacent), which is real - the engine's own catalogue has
	// `assert.jsonpath` describing itself that way beside `extract.regex`.
	// `commandFilter` (`index.tsx`) exists to keep a search literal. Mutation
	// check: drop the `filter={commandFilter}` prop from `Command` in
	// `index.tsx` and this reddens - both kinds would show for "regex".
	it("matches a literal substring, not cmdk's default fuzzy subsequence", async () => {
		const kinds: ElementKindSchema[] = [
			kindSchema({
				kind: "extract.regex",
				label: "Extract with a regular expression",
				category: "extract",
				description: "Runs a regular expression against the response.",
			}),
			kindSchema({
				kind: "assert.jsonpath",
				label: "Assert JSON value",
				category: "assert",
				description: "Matches a value or matches a regular expression.",
			}),
		];
		render(<ElementList elements={[]} onChange={vi.fn()} kinds={kinds} />);
		openMenu();
		await screen.findByText("Assert JSON value");

		fireEvent.change(screen.getByPlaceholderText("Search elements"), {
			target: { value: "regex" },
		});

		expect(screen.getByText("Extract with a regular expression")).toBeInTheDocument();
		expect(screen.queryByText("Assert JSON value")).not.toBeInTheDocument();
	});

	it("adds a new, enabled element of the picked kind, and closes the picker", async () => {
		const onChange = renderList([]);
		openMenu();
		await screen.findByText("Assert Status");

		fireEvent.click(optionRow("Assert Status"));

		expect(onChange).toHaveBeenCalledTimes(1);
		const added = (onChange.mock.calls[0][0] as ElementDef[])[0];
		expect(added.kind).toBe("assert.status");
		expect(added.enabled).toBe(true);
		expect(added.config).toEqual({});
		expect(typeof added.id).toBe("string");
		expect(added.id.length).toBeGreaterThan(0);
		// The popover closes on select - its content unmounts from the portal.
		expect(screen.queryByText("Assert Status")).not.toBeInTheDocument();
	});

	// A script kind's schema requires the `script` key present (engine-side,
	// `script_kinds.cpp`) - `config: {}` alone omits it, and the engine
	// validates a request's whole `elements` array on every save, so one
	// still-blank script element fails every later save of the request, not
	// just its own. `{ script: "" }` satisfies the schema outright and is a
	// real value, not a placeholder: the engine already treats a blank
	// script as a no-op.
	//
	// Mutation check: revert `defaultConfigFor` (`index.tsx`) to always
	// return `{}` and this reddens with `config: {}`.
	it("seeds a script kind's config with an empty script, not an empty object", async () => {
		const onChange = renderList([]);
		openMenu();
		await screen.findByText("Pre-request Script");

		fireEvent.click(optionRow("Pre-request Script"));

		const added = (onChange.mock.calls[0][0] as ElementDef[])[0];
		expect(added.kind).toBe("script.pre");
		expect(added.config).toEqual({ script: "" });
	});

	it("remembers the picked kind under Recently used on the next open", async () => {
		renderList([]);
		openMenu();
		await screen.findByText("Assert Status");
		fireEvent.click(optionRow("Assert Status"));

		openMenu();
		await screen.findByText("Recently used");

		// Once under Recently used, once in its own category group.
		expect(screen.getAllByText("Assert Status")).toHaveLength(2);
	});
});

describe("ElementList - enabling, deleting and duplicating a row", () => {
	it("toggles enabled off through onChange, keeping everything else the same", () => {
		const onChange = renderList([extractElement("e1")]);

		fireEvent.click(screen.getByRole("switch", { name: /enable extract json/i }));

		expect(onChange).toHaveBeenCalledWith([{ ...extractElement("e1"), enabled: false }]);
	});

	it("dims a disabled row", () => {
		renderList([{ ...extractElement("e1"), enabled: false }]);

		expect(rowFor("Extract JSON").className).toContain("opacity-60");
	});

	it("removes a blank element straight away, with no confirmation", async () => {
		const onChange = renderList([extractElement("e1"), assertElement("a1")]);

		await chooseRowAction("Extract JSON", "Delete");

		expect(onChange).toHaveBeenCalledWith([assertElement("a1")]);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("confirms before deleting an element that has configuration", async () => {
		const onChange = renderList([extractElement("e1", "$.token")]);

		await chooseRowAction("Extract JSON", "Delete");
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(onChange).toHaveBeenCalledWith([]);
	});

	it("keeps the element when the delete confirmation is cancelled", async () => {
		const onChange = renderList([extractElement("e1", "$.token")]);

		await chooseRowAction("Extract JSON", "Delete");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onChange).not.toHaveBeenCalled();
	});

	it("duplicates a row with a fresh id, a ' copy' suffixed name, opened expanded", async () => {
		const onChange = renderList([extractElement("e1", "$.token")]);

		await chooseRowAction("Extract JSON", "Duplicate");

		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0] as ElementDef[];
		expect(next).toHaveLength(2);
		expect(next[1].id).not.toBe("e1");
		expect(next[1].name).toBe("Extract JSON copy");
		expect(next[1].config).toEqual({ path: "$.token" });
	});
});

describe("ElementList - rename", () => {
	it("reveals the name input, commits on Enter, and shows the new name", async () => {
		const onChange = renderList([extractElement("e1")]);

		await chooseRowAction("Extract JSON", "Rename");
		const input = await screen.findByPlaceholderText("Extract JSON");
		fireEvent.change(input, { target: { value: "Token lookup" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(onChange).toHaveBeenCalledWith([{ ...extractElement("e1"), name: "Token lookup" }]);
	});

	it("reverts on Escape without committing", async () => {
		const onChange = renderList([extractElement("e1")]);

		await chooseRowAction("Extract JSON", "Rename");
		const input = await screen.findByPlaceholderText("Extract JSON");
		fireEvent.change(input, { target: { value: "Discarded" } });
		fireEvent.keyDown(input, { key: "Escape" });

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.queryByPlaceholderText("Extract JSON")).not.toBeInTheDocument();
		expect(screen.getByText("Extract JSON")).toBeInTheDocument();
	});

	// A `name` is user-typed, with no length limit - `title`'s own span has to
	// stay truncatable (a real `max-width` alongside `truncate`), or an
	// unusually long one renders at its full content width regardless of the
	// row's own size and pushes the enable switch and the `⋯` menu out of
	// view instead of yielding to them (found live: jsdom has no layout, so
	// this is a class-list assertion, not a measured overflow - see the
	// `boxed-surfaces.test.tsx` pattern `app/CLAUDE.md` names for this class
	// of bug).
	//
	// Mutation check: drop `max-w-[55%]` from the title `<span>` in
	// `index.tsx`, keeping `shrink-0 truncate` - this reddens, since
	// `truncate` alone never engages without a `max-width` to truncate
	// against.
	it("keeps the title span truncatable, not just shrink-resistant", async () => {
		render(<StatefulList initial={[extractElement("e1")]} />);
		await chooseRowAction("Extract JSON", "Rename");
		const input = await screen.findByPlaceholderText("Extract JSON");
		fireEvent.change(input, { target: { value: "A rather long custom element name" } });
		fireEvent.keyDown(input, { key: "Enter" });

		const title = screen.getByText("A rather long custom element name");
		expect(title.parentElement?.className).toMatch(/(^|\s)max-w-\[55%\](\s|$)/);
		expect(title.parentElement?.className).toMatch(/\btruncate\b/);
	});
});

describe("ElementList - reordering", () => {
	it("swaps two adjacent elements when the second is moved up", async () => {
		const onChange = renderList([extractElement("e1"), assertElement("a1")]);

		await chooseRowAction("Assert Status", "Move up");

		expect(onChange).toHaveBeenCalledWith([assertElement("a1"), extractElement("e1")]);
	});

	it("swaps two adjacent elements when the first is moved down", async () => {
		const onChange = renderList([extractElement("e1"), assertElement("a1")]);

		await chooseRowAction("Extract JSON", "Move down");

		expect(onChange).toHaveBeenCalledWith([assertElement("a1"), extractElement("e1")]);
	});

	async function openRowMenu(title: string) {
		const trigger = within(rowFor(title)).getByRole("button", {
			name: `More actions for ${title}`,
		});
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
		fireEvent.click(trigger, { detail: 1 });
		await screen.findByRole("menu");
	}

	it("disables moving the first row up and the last row down", async () => {
		renderList([extractElement("e1"), assertElement("a1")]);

		await openRowMenu("Extract JSON");
		expect(screen.getByRole("menuitem", { name: "Move up" })).toHaveAttribute(
			"aria-disabled",
			"true"
		);
		fireEvent.keyDown(screen.getByRole("menuitem", { name: "Move up" }), { key: "Escape" });

		await openRowMenu("Assert Status");
		expect(screen.getByRole("menuitem", { name: "Move down" })).toHaveAttribute(
			"aria-disabled",
			"true"
		);
	});

	it("moves the focused card with Alt+ArrowDown", () => {
		const onChange = renderList([extractElement("e1"), assertElement("a1")]);

		// Fired on a control inside the row, not the row itself: React's
		// `onKeyDown` only hears events bubbling up from a descendant.
		fireEvent.keyDown(
			within(rowFor("Extract JSON")).getByRole("button", { name: "Expand Extract JSON" }),
			{ key: "ArrowDown", altKey: true }
		);

		expect(onChange).toHaveBeenCalledWith([assertElement("a1"), extractElement("e1")]);
	});
});

describe("ElementList - empty state", () => {
	it("shows quick-add chips instead of the list when there are no elements", () => {
		renderList([]);

		expect(screen.getByText(/no elements yet/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Extract from JSON" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Assert status code" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Pre-request script" })).toBeInTheDocument();
		// `script.setup` is not in `KINDS` here (it is `collectionOnly` and this
		// fixture models a request tab's addable set) - no chip for it.
		expect(screen.queryByRole("button", { name: "Setup script" })).not.toBeInTheDocument();
	});

	it("hides the chips once an element exists", () => {
		renderList([extractElement("e1")]);

		expect(screen.queryByText(/no elements yet/i)).not.toBeInTheDocument();
	});

	it("adds the chip's kind, expanded, on click", () => {
		const onChange = renderList([]);

		fireEvent.click(screen.getByRole("button", { name: "Assert status code" }));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect((onChange.mock.calls[0][0] as ElementDef[])[0].kind).toBe("assert.status");
	});
});
