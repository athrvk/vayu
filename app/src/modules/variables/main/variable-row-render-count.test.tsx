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
 * Issue #1716: `VariableTableEditor` used to render every row inline in a
 * `.map`, with no row component of its own, so `updateVariable` rebuilding the
 * whole `variables` array on every keystroke re-rendered every row's `Input`,
 * `Select` and `SecretInput` on every character typed in any one of them.
 *
 * `VariableRow` is extracted and `memo`-wrapped now, keyed by `variable.id`,
 * and `updateVariable`/`removeVariable`/`commitNow` are ref-backed so their
 * identities survive a keystroke - see `VariableTableEditor.tsx` and
 * `VariableRow.tsx`. `./VariableRow` is mocked here with a second, identically
 * shallow `memo` whose body counts renders per row id before delegating to the
 * real component, the same technique `KeyValueEditor/index.test.tsx` uses and
 * for the same reason: a `Profiler` around the row list would fire on every
 * commit regardless of which memoized child actually re-executed its render
 * function, which is exactly the distinction this test needs.
 */

import { describe, it, expect, vi } from "vitest";
import { memo, createElement, type ComponentProps } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import VariableTableEditor from "./VariableTableEditor";
import { TooltipProvider } from "@/components/ui";
import type VariableRowType from "./VariableRow";
import type { Collection, VariableValue } from "@/types";

const renderCounts: Record<string, number> = {};

vi.mock("./VariableRow", async (importOriginal) => {
	const mod = await importOriginal<{ default: typeof VariableRowType }>();
	const Counting = memo((props: ComponentProps<typeof VariableRowType>) => {
		// Keyed by the variable's `key` field (`v1`..`v5`), not its editor-local
		// `id` (`vrow-N`, assigned by a module-global counter this test has no
		// business depending on) - the two identify the same row here since the
		// fixture below never renames one.
		const rowKey = props.variable.key;
		renderCounts[rowKey] = (renderCounts[rowKey] ?? 0) + 1;
		return createElement(mod.default, props);
	});
	return { default: Counting };
});

const updateCollection = vi.fn();

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
	useUpdateCollectionMutation: () => ({
		mutate: (...args: unknown[]) => updateCollection(...args),
		mutateAsync: vi.fn(),
	}),
}));

const sessionStore = { activeEnvironmentId: null, setActiveEnvironmentId: vi.fn() };

const saveStoreState = {
	registerContext: vi.fn(),
	unregisterContext: vi.fn(),
	updateContext: vi.fn(),
	setActiveContext: vi.fn(),
	markPendingSave: vi.fn(),
	startSaving: vi.fn(),
	completeSaveThenIdle: vi.fn(),
	failSave: vi.fn(),
	setStatus: vi.fn(),
};

const variablesStoreState = { selectedCategory: null, setSelectedCategory: vi.fn() };

vi.mock("@/stores", () => ({
	useSaveStore: (selector: (state: typeof saveStoreState) => unknown) => selector(saveStoreState),
	useSessionStore: Object.assign(() => sessionStore, { getState: () => sessionStore }),
}));

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: (selector: (state: typeof variablesStoreState) => unknown) =>
		selector(variablesStoreState),
}));

function variable(value: string, createdAt: number): VariableValue {
	return { value, enabled: true, secret: false, type: "string", createdAt };
}

const collection: Collection = {
	id: "col_1",
	name: "demo",
	description: "",
	order: 0,
	variables: {
		v1: variable("a", 1000),
		v2: variable("b", 2000),
		v3: variable("c", 3000),
		v4: variable("d", 4000),
		v5: variable("e", 5000),
	},
	auth: { mode: "none" },
	elements: [],
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

describe("row re-renders under a keystroke", () => {
	it("re-renders only the row being typed in, not its siblings", () => {
		render(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "collection", collection }} />
			</TooltipProvider>
		);

		const keyInputs = screen.getAllByPlaceholderText("variable_name");
		expect(keyInputs).toHaveLength(6); // five rows plus the trailing blank

		// v3 sorts third by createdAt - its value field is the third "value" input.
		const valueInputs = screen.getAllByPlaceholderText("value");

		/*
		 * The first edit of a session sets `hasPendingChanges` and every row's
		 * `variable.isNew`/`createdAt` bookkeeping in one pass - a one-time cost
		 * every fresh mount pays, not the defect issue #1716 is about. Absorbing
		 * it before the counts are zeroed is what isolates the per-keystroke
		 * behaviour the test actually asserts.
		 */
		fireEvent.change(valueInputs[2], { target: { value: "c" } });

		for (const key of ["v1", "v2", "v3", "v4", "v5"]) renderCounts[key] = 0;

		fireEvent.change(valueInputs[2], { target: { value: "c!" } });

		expect(renderCounts.v3).toBeGreaterThan(0);
		expect(renderCounts.v1).toBe(0);
		expect(renderCounts.v2).toBe(0);
		expect(renderCounts.v4).toBe(0);
		expect(renderCounts.v5).toBe(0);
	});
});
