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
 * The variables table and the shared `KeyValueEditor` are two tables, on
 * purpose - and this is the contract that keeps them from drifting apart where
 * they are the same thing.
 *
 * #587 asked whether the variables table should mount the shared primitive and
 * concluded no: it adds a type select, a secret toggle and a masked value cell,
 * commits text on blur rather than on change, and orders rows by `createdAt`,
 * so folding it in means a dynamic column model plus a commit model on a
 * primitive whose three other consumers need neither. The exclusion is
 * deliberate; the *drift* it invites is not, which is the risk the repo's
 * "a hand-rolled copy of a primitive does not receive the primitive's fixes"
 * rule names. So the shared row's decisions that are not variables-specific -
 * control height, checkbox clearance and sizing, the destructive row action,
 * and the secret-reveal control - are pinned here against the primitive itself
 * rather than against copied literals. A fix on either side that skips the
 * other fails this file.
 *
 * The reveal control is the one piece that *is* unified: `ui/secret-input` was
 * extracted from this table's own eye toggle and then received fixes the copy
 * left here never did (the `tabIndex={-1}` removal, `aria-pressed`), so the
 * value cell mounts the primitive and the assertion below is that it still
 * does.
 *
 * The original clipping case, kept as the first block:
 *
 * `overflow-y-auto` computes `overflow-x` to `auto` as well, so the scroll
 * container clips horizontally at its padding box. On the Variables screen the
 * container carries `p-4` and nothing notices. Embedded in Collection Detail it
 * carries `p-0`, the checkbox cell's left edge *is* the clip edge, and the
 * baseline focus ring - 1px wide at `outline-offset: 2px`, i.e. 3px outside the
 * border box - lost its left side. Same component, same code path; only the
 * padding differs, which is why it reproduced on one screen and not the other.
 *
 * **Fixed with clearance, deliberately not with `.panel-clip`.** The design
 * system offers both (docs/design-system.md, "Clipping panels" and the
 * clearance rule), and for this control clearance is the only one that keeps it
 * consistent: the identical native checkbox appears in the request builder's
 * key-value rows, where `KeyValueRow`'s `p-1` leaves the ring outset with a
 * visible gap. `.panel-clip` would have tucked this one inward, giving one
 * control two different looks depending on the screen.
 *
 * So the guard is a comparison, not an absolute: both checkboxes must have the
 * same clearance, and neither may sit under a `.panel-clip`. Asserting only
 * that the variables cell has padding would pass a future change that also
 * added `.panel-clip` and quietly re-broke the consistency.
 *
 * jsdom computes no layout, so this asserts the declarations that produce the
 * geometry - the level `surface-rule.test.tsx` guards at, and the only level
 * available. A source scan could not: the classes arrive through `cn()`.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import VariableTableEditor from "./VariableTableEditor";
import KeyValueRow from "@/components/shared/KeyValueEditor/KeyValueRow";
import { TooltipProvider, Button, SecretInput } from "@/components/ui";
import type { Collection } from "@/types";

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: undefined, isLoading: false, error: null }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useSetActiveEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useDeleteEnvironmentMutation: () => ({
		mutate: vi.fn(),
		mutateAsync: vi.fn(),
		isPending: false,
	}),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

const sessionStore = { activeEnvironmentId: null, setActiveEnvironmentId: vi.fn() };

vi.mock("@/stores", () => ({
	useSaveStore: () => ({
		registerContext: vi.fn(),
		unregisterContext: vi.fn(),
		updateContext: vi.fn(),
		setActiveContext: vi.fn(),
		markPendingSave: vi.fn(),
		startSaving: vi.fn(),
		completeSaveThenIdle: vi.fn(),
		failSave: vi.fn(),
		setStatus: vi.fn(),
	}),
	useSessionStore: Object.assign(() => sessionStore, { getState: () => sessionStore }),
}));

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

// KeyValueRow reads the builder context only to resolve `{{vars}}` for its
// preview column; same shape its own test uses.
vi.mock("@/modules/request-builder/context/RequestBuilderContext", () => ({
	useRequestBuilderContext: () => ({
		resolveString: (s: string) => s,
		getAllVariables: () => ({}),
		updateVariable: () => {},
	}),
}));

function collectionWith(secret: boolean): Collection {
	return {
		id: "col_1",
		name: "demo",
		description: "",
		order: 0,
		variables: {
			test: { value: "5123", enabled: true, secret, type: "string", createdAt: 1 },
		},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	};
}

const collection = collectionWith(false);

/**
 * Horizontal padding declared on the checkbox's own box, in Tailwind steps
 * (`px-1` and `p-1` both count as 1). The ring needs 3px, so anything below
 * step 1 (4px) clips.
 */
function horizontalPadStep(checkbox: Element): number {
	const cls = String(checkbox.parentElement?.className ?? "");
	const match = cls.match(/\bp[xl]?-(\d+)\b/);
	return match ? Number(match[1]) : 0;
}

/** Whether any ancestor tucks descendant rings inward. */
function underPanelClip(el: Element): boolean {
	let node: Element | null = el.parentElement;
	while (node) {
		if (/\bpanel-clip\b/.test(String(node.className ?? ""))) return true;
		node = node.parentElement;
	}
	return false;
}

/**
 * The height a text field declares.
 *
 * The two tables put the class in different places - `KeyValueRow` passes
 * `h-8` to `VariableInput`, whose wrapper owns the box, while the variables
 * table puts it on the `Input` itself - so this walks out from the input until
 * it finds the element that declares a height. Comparing the *value* is the
 * point; which element carries it is each table's business.
 */
function declaredHeight(input: Element): string {
	let node: Element | null = input;
	for (let hops = 0; node && hops < 3; hops++, node = node.parentElement) {
		const match = String(node.className ?? "").match(/\bh-(\d+(?:\.\d+)?)\b/);
		if (match) return `h-${match[1]}`;
	}
	throw new Error("no height declared on the field or its box - the markup changed");
}

/**
 * What a Button variant paints, read off the primitive itself.
 *
 * Taken as the difference against another variant so the shared base classes
 * (layout, transition, ring) drop out: those are the ones a caller's own
 * `className` legitimately overrides through `cn()`, and asserting them would
 * make this fail on styling the row is entitled to choose.
 */
function variantClasses(variant: "rowActionDestructive"): string[] {
	const classesOf = (v: "rowActionDestructive" | "ghost") => {
		const { container } = render(
			<Button variant={v} size="icon" aria-label="variant reference">
				ref
			</Button>
		);
		const button = container.querySelector("button");
		if (!button) throw new Error("Button rendered no button");
		return String(button.className).split(/\s+/).filter(Boolean);
	};
	const baseline = new Set(classesOf("ghost"));
	const paint = classesOf(variant).filter((c) => !baseline.has(c));
	if (paint.length === 0) throw new Error("variant contributes nothing - scanned an empty set");
	return paint;
}

function renderVariables(embedded: boolean, secret = false) {
	return render(
		<TooltipProvider>
			<VariableTableEditor
				config={{
					type: "collection",
					collection: secret ? collectionWith(true) : collection,
				}}
				embedded={embedded}
			/>
		</TooltipProvider>
	);
}

function renderVariablesCheckbox(embedded: boolean): Element {
	const { container } = renderVariables(embedded);
	const checkbox = container.querySelector('input[type="checkbox"]');
	if (!checkbox) throw new Error("no checkbox rendered - the table markup changed");
	return checkbox;
}

function renderKeyValueRow() {
	return render(
		<TooltipProvider>
			<KeyValueRow
				item={{ id: "1", key: "a", value: "b", enabled: true }}
				keyPlaceholder="Parameter"
				valuePlaceholder="Value"
				showResolved={false}
				readOnly={false}
				onUpdate={vi.fn()}
				onPickFile={vi.fn()}
				onToggleKind={vi.fn()}
				onRemove={vi.fn()}
				allowDisable
				canDisable
			/>
		</TooltipProvider>
	);
}

function renderKeyValueCheckbox(): Element {
	const { container } = renderKeyValueRow();
	const checkbox = container.querySelector('input[type="checkbox"]');
	if (!checkbox) throw new Error("no checkbox rendered - KeyValueRow markup changed");
	return checkbox;
}

describe("row-enable checkbox - focus ring clearance", () => {
	it.each([
		["embedded (Collection Detail, p-0 container)", true],
		["standalone (Variables screen, p-4 container)", false],
	])("has room for its outset ring: %s", (_label, embedded) => {
		expect(horizontalPadStep(renderVariablesCheckbox(embedded))).toBeGreaterThanOrEqual(1);
	});

	it("matches the clearance of the identical checkbox in the request builder", () => {
		expect(horizontalPadStep(renderVariablesCheckbox(true))).toBe(
			horizontalPadStep(renderKeyValueCheckbox())
		);
	});

	it("neither checkbox sits under a panel-clip, so both rings stay outset", () => {
		// The consistency half. Clearance alone is not enough: a `.panel-clip`
		// ancestor would flip one of them to an inset ring and the two controls
		// would stop matching, with the padding assertions still green.
		expect(underPanelClip(renderVariablesCheckbox(true))).toBe(false);
		expect(underPanelClip(renderKeyValueCheckbox())).toBe(false);
	});
});

describe("row-enable checkbox - the rest of the control", () => {
	it("is the same size in both tables", () => {
		const boxSize = (el: Element) =>
			String(el.className)
				.split(/\s+/)
				.filter((c) => /^[hw]-\d/.test(c))
				.sort()
				.join(" ");
		expect(boxSize(renderVariablesCheckbox(true))).toBe(boxSize(renderKeyValueCheckbox()));
	});

	it("paints in an app colour in both tables, never the browser default", () => {
		// A native checkbox with no `accent-*` renders the user agent's blue,
		// which follows neither the theme nor the accent scheme. `KeyValueRow`
		// carries `accent-primary`; this table carries the scope colour.
		for (const checkbox of [renderVariablesCheckbox(true), renderKeyValueCheckbox()]) {
			expect(String(checkbox.className)).toMatch(/\baccent-[a-z-]+\b/);
		}
	});
});

describe("field height", () => {
	it("is the same in both tables, so the two row pitches stay in step", () => {
		const { container: vars } = renderVariables(true);
		const { container: kv } = renderKeyValueRow();
		const varsField = vars.querySelector('input[type="text"]');
		const kvField = kv.querySelector('input[type="text"]');
		if (!varsField || !kvField) throw new Error("a table stopped rendering text fields");
		expect(declaredHeight(varsField)).toBe(declaredHeight(kvField));
	});
});

describe("destructive row action", () => {
	it("uses the shared Button variant in the variables table, not a hand-rolled destructive style", () => {
		renderVariables(true);
		const remove = screen.getByRole("button", { name: "Delete variable" });
		// Read off the primitive rather than hardcoded: a change to what
		// `rowActionDestructive` paints has to reach this table too.
		for (const cls of variantClasses("rowActionDestructive")) {
			expect(String(remove.className).split(/\s+/)).toContain(cls);
		}
	});

	it("is visible under keyboard focus in both tables, not on hover alone", () => {
		// The primitive's fix (#: a keyboard user tabbing through a table
		// landed on a fully transparent control and Enter deleted a row they
		// could not see). Both tables reveal on focus - `KeyValueRow` through
		// `focus-visible:` on the button, this one through `group-focus-within:`
		// on the row - so the assertion is that each declares one of them.
		renderVariables(true);
		const varsRemove = screen.getByRole("button", { name: "Delete variable" });
		const { container: kv } = renderKeyValueRow();
		const kvRemove = within(kv as HTMLElement).getByRole("button", { name: "Remove row" });
		for (const button of [varsRemove, kvRemove]) {
			expect(String(button.className)).toMatch(
				/(focus-visible|group-focus-within):opacity-100/
			);
		}
	});
});

describe("secret value cell", () => {
	it("mounts the shared SecretInput rather than a second reveal toggle", () => {
		const { container } = renderVariables(true, true);
		expect(container.querySelector('input[type="password"]')).not.toBeNull();

		// The primitive's contract, read off the primitive: same accessible
		// name and the pressed state a copy of it went without.
		const { container: ref } = render(
			<TooltipProvider>
				<SecretInput value="x" onChange={() => {}} />
			</TooltipProvider>
		);
		const refToggle = ref.querySelector("button");
		if (!refToggle) throw new Error("SecretInput rendered no toggle");

		const toggle = within(container as HTMLElement).getByRole("button", {
			name: String(refToggle.getAttribute("aria-label")),
		});
		expect(toggle).toHaveAttribute("aria-pressed", refToggle.getAttribute("aria-pressed"));
	});

	it("reveals the value when the toggle is activated", () => {
		const { container } = renderVariables(true, true);
		expect(container.querySelector('input[type="password"]')).not.toBeNull();

		fireEvent.click(
			within(container as HTMLElement).getByRole("button", { name: "Show value" })
		);
		expect(container.querySelector('input[type="password"]')).toBeNull();
	});

	it("leaves a non-secret row as a plain field", () => {
		const { container } = renderVariables(true, false);
		expect(container.querySelector('input[type="password"]')).toBeNull();
		expect(
			within(container as HTMLElement).queryByRole("button", { name: "Show value" })
		).toBeNull();
	});
});
