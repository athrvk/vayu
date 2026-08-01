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
 * Editing a variable in the context bar used to fail in complete silence.
 *
 * The three mutations were fired with no `onError`, nothing read `isError`, and
 * there is no global `MutationCache.onError` in `lib/query-client.ts` - so an
 * engine 400 or a refused connection left the typed value sitting in the input
 * looking committed. The inputs are uncontrolled (`defaultValue`, with a `key`
 * derived from the stored value), so a rejected save changes nothing that would
 * put the old text back: the cache never moved, therefore neither did the key.
 *
 * Both halves are asserted - the toast, and the value on screen - because a
 * toast beside an input still showing the new value tells the user their edit
 * was saved and also that it failed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ContextBar } from "./ContextBar";
import { useToastStore } from "@/stores/toast-store";
import { useSaveStore } from "@/stores/save-store";
import type { ResolvedVariable } from "@/types";

const globalsMutate = vi.fn();

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: { id: "req_1", collectionId: null } }),
	useGlobalsQuery: () => ({
		data: {
			variables: {
				host: { value: "example.com", enabled: true, secret: false, type: "string" },
			},
		},
	}),
	useCollectionsQuery: () => ({ data: [] }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateGlobalsMutation: () => ({ mutate: globalsMutate }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
}));

const resolved: Record<string, ResolvedVariable> = {
	host: { value: "example.com", scope: "global" },
};

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ getAllVariables: () => resolved }),
}));

const layoutStore = {
	contextBarOpen: true,
	setContextBarOpen: vi.fn(),
	contextBarWidth: 280,
	setContextBarWidth: vi.fn(),
};
const tabsStore = {
	openTabs: [{ id: "t1", type: "request", entityId: "req_1" }],
	activeTabId: "t1",
};

vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	return {
		useLayoutStore: () => layoutStore,
		useTabsStore: () => tabsStore,
		useSessionStore: () => ({ activeEnvironmentId: null }),
		useSaveStore: saveStore.useSaveStore,
	};
});

function valueInput(): HTMLInputElement {
	return screen.getByDisplayValue("example.com") as HTMLInputElement;
}

describe("ContextBar - a rejected variable edit", () => {
	beforeEach(() => {
		globalsMutate.mockReset();
		useToastStore.setState({ toasts: [] });
		useSaveStore.getState().reset();
	});

	it("toasts the engine's reason and puts the stored value back", () => {
		globalsMutate.mockImplementation(
			(_payload: unknown, opts: { onError: (e: Error) => void }) => {
				opts.onError(new Error("value must not be empty"));
			}
		);

		render(<ContextBar />);
		const input = valueInput();

		act(() => {
			fireEvent.change(input, { target: { value: "example.org" } });
			fireEvent.blur(input);
		});

		expect(globalsMutate).toHaveBeenCalledTimes(1);
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].message).toBe("value must not be empty");
		expect(toasts[0].variant).toBe("error");
		expect(input.value).toBe("example.com");
	});

	it("refuses out loud when the variable is gone from its scope", () => {
		// The scope map no longer holds it - deleted elsewhere between render and
		// blur. Writing it back would resurrect it, so the edit is dropped; the
		// old code dropped it without a word.
		delete resolved.host;
		resolved.missing = { value: "example.com", scope: "global" };

		render(<ContextBar />);
		const input = valueInput();

		act(() => {
			fireEvent.change(input, { target: { value: "example.org" } });
			fireEvent.blur(input);
		});

		expect(globalsMutate).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts).toHaveLength(1);
		expect(input.value).toBe("example.com");

		delete resolved.missing;
		resolved.host = { value: "example.com", scope: "global" };
	});
});
