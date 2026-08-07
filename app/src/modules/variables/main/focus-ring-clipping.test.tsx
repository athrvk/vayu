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
 * The variables table scrolls, so it clips - and the row-enable checkbox sat
 * flush against that clip edge.
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
import { render } from "@testing-library/react";
import VariableTableEditor from "./VariableTableEditor";
import KeyValueRow from "@/modules/request-builder/shared/KeyValueEditor/KeyValueRow";
import { TooltipProvider } from "@/components/ui";
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

const collection: Collection = {
	id: "col_1",
	name: "demo",
	description: "",
	order: 0,
	variables: {
		test: { value: "5123", enabled: true, secret: false, type: "string", createdAt: 1 },
	},
	auth: { mode: "none" },
	preRequestScript: "",
	postRequestScript: "",
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

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

function renderVariablesCheckbox(embedded: boolean): Element {
	const { container } = render(
		<TooltipProvider>
			<VariableTableEditor config={{ type: "collection", collection }} embedded={embedded} />
		</TooltipProvider>
	);
	const checkbox = container.querySelector('input[type="checkbox"]');
	if (!checkbox) throw new Error("no checkbox rendered - the table markup changed");
	return checkbox;
}

function renderKeyValueCheckbox(): Element {
	const { container } = render(
		<TooltipProvider>
			<KeyValueRow
				item={{ id: "1", key: "a", value: "b", enabled: true }}
				keyPlaceholder="Parameter"
				valuePlaceholder="Value"
				showResolved={false}
				readOnly={false}
				onUpdate={vi.fn()}
				onRemove={vi.fn()}
				allowDisable
				canDisable
			/>
		</TooltipProvider>
	);
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
