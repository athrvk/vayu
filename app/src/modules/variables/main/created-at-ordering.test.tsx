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
 * Add a variable to a scope that already has some and the new row jumped
 * *above* the old ones (issue #135).
 *
 * The sort was never at fault. Rows order by `createdAt`, oldest first, and the
 * stored data really did say the new row was older - because a row whose
 * `createdAt` was missing got backfilled with `Date.now()` at **save** time,
 * and the save fires after the keystroke that stamped the new row. The
 * pre-existing row therefore received the newer timestamp and leapfrogged.
 *
 * Rows arrive with no `createdAt` for two reasons: they predate the field, or
 * an older engine stripped it while persisting script variables (fixed on the
 * engine side in the same change). Either way the app must treat "unknown" as
 * older than everything and leave it unknown, so the set of untimestamped rows
 * stays put instead of shuffling one at a time as each save happens to touch it.
 *
 * The assertions are on the **saved payload**, not on the rendered order: the
 * bad timestamp is written at save and only shows up in the list after the
 * round trip, so a render-order check passes on the broken code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import VariableTableEditor from "./VariableTableEditor";
import { TooltipProvider } from "@/components/ui";
import type { Collection, VariableValue } from "@/types";

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

vi.mock("@/stores", () => ({
	useSaveStore: () => ({
		registerContext: vi.fn(),
		unregisterContext: vi.fn(),
		updateContext: vi.fn(),
		setActiveContext: vi.fn(),
		markPendingSave: vi.fn(),
		startSaving: vi.fn(),
		completeSave: vi.fn(),
		failSave: vi.fn(),
		setStatus: vi.fn(),
	}),
	useSessionStore: Object.assign(() => sessionStore, { getState: () => sessionStore }),
}));

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

/** `stripped` has lost its createdAt; `kept` still has one. */
const collection: Collection = {
	id: "col_1",
	name: "demo",
	description: "",
	order: 0,
	variables: {
		stripped: { value: "a", enabled: true, secret: false, type: "string" },
		kept: { value: "b", enabled: true, secret: false, type: "string", createdAt: 2000 },
	},
	auth: { mode: "none" },
	preRequestScript: "",
	postRequestScript: "",
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

const TYPED_AT = 5000;
const SAVED_AT = 9000;

/**
 * Type a key into the trailing blank row, then blur to save. The two clock
 * positions are what make the defect deterministic: the new row is stamped at
 * TYPED_AT, and the broken backfill would stamp the untimestamped row at the
 * strictly later SAVED_AT.
 */
function addVariableAndSave(name: string): Record<string, VariableValue> {
	render(
		<TooltipProvider>
			<VariableTableEditor config={{ type: "collection", collection }} />
		</TooltipProvider>
	);

	const keyInputs = screen.getAllByPlaceholderText("variable_name");
	const blankRow = keyInputs[keyInputs.length - 1];

	vi.setSystemTime(TYPED_AT);
	fireEvent.change(blankRow, { target: { value: name } });

	vi.setSystemTime(SAVED_AT);
	fireEvent.blur(blankRow);

	expect(updateCollection).toHaveBeenCalledTimes(1);
	const payload = updateCollection.mock.calls[0][0] as {
		variables: Record<string, VariableValue>;
	};
	return payload.variables;
}

describe("variables editor - createdAt ordering", () => {
	beforeEach(() => {
		updateCollection.mockClear();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not invent a creation time for a row that has none", () => {
		const saved = addVariableAndSave("fresh");

		// The regression. Backfilling here is what moved an old row below a new
		// one, and it also writes a timestamp the user's data never had.
		expect(saved.stripped.createdAt).toBeUndefined();
		expect(saved.kept.createdAt).toBe(2000);
	});

	it("stamps the row the user just typed, and only that one", () => {
		const saved = addVariableAndSave("fresh");

		expect(saved.fresh.createdAt).toBe(TYPED_AT);
	});

	it("keeps the new row last and every existing row where it was", () => {
		// Payload key order is the round-tripped display order, so this is the
		// user-visible claim: the row just added sits at the bottom, the
		// untimestamped row stays at the top.
		expect(Object.keys(addVariableAndSave("fresh"))).toEqual(["stripped", "kept", "fresh"]);
	});
});
