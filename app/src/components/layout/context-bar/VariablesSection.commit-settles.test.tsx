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
 * Every commit the bar opens settles, so "Saving…" ends (#3350).
 *
 * The commit used to settle from `mutate`'s per-call `onSettled`. A TanStack
 * observer holds one set of per-call callbacks: the next `mutate` replaces it,
 * and an unmounted host has no listener left to call it. Either way that
 * commit stayed in the bar's pending set and the Dock said "Saving…" until
 * restart. The mutations here are real `useMutation`s over a held PUT, because
 * a mocked `mutate` calls whatever it is handed and cannot drop anything.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VariablesSection } from "./VariablesSection";
import { TooltipProvider } from "@/components/ui";
import { queryKeys } from "@/queries/keys";
import { resetSaveStoreForTests, useSaveStore } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import type { ResolvedVariable, VariableValue } from "@/types";

/** Each PUT's answer, in the order the PUTs went out. */
const answers: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
const putGlobals = vi.fn(
	() =>
		new Promise<void>((resolve, reject) => {
			answers.push({ resolve, reject });
		})
);

vi.mock("@/queries", async () => {
	const { useMutation } =
		await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
	return {
		useRequestQuery: () => ({
			data: {
				id: "req_1",
				collectionId: null,
				url: Object.keys(resolved)
					.map((name) => `{{${name}}}`)
					.join(" "),
				params: [],
				headers: [],
				body: { mode: "none" },
				auth: { mode: "none" },
				elements: [],
			},
		}),
		useCollectionAncestors: () => [],
		useUpdateGlobalsMutation: () => useMutation({ mutationFn: putGlobals }),
		useUpdateEnvironmentMutation: () => useMutation({ mutationFn: vi.fn() }),
		useUpdateCollectionMutation: () => useMutation({ mutationFn: vi.fn() }),
	};
});

const resolved: Record<string, ResolvedVariable> = {
	host: { value: "example.com", scope: "global" },
	port: { value: "8080", scope: "global" },
};

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({
		getAllVariables: () => resolved,
		getVariable: (name: string) => resolved[name] ?? null,
	}),
}));

vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	return { useSaveStore: saveStore.useSaveStore };
});

const TAB = { id: "t1", type: "request", entityId: "req_1" } as const;

const def = (value: string): VariableValue => ({ value, enabled: true });

function renderSection() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	client.setQueryData(queryKeys.globals.all, {
		id: "globals",
		updatedAt: "",
		variables: { host: def("example.com"), port: def("8080") },
	});
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<VariablesSection tab={TAB} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

function commit(shown: string, value: string) {
	const input = screen.getByDisplayValue(shown) as HTMLInputElement;
	act(() => {
		fireEvent.change(input, { target: { value } });
		fireEvent.blur(input);
	});
}

/** Wait for `count` PUTs to have reached the transport. */
const putsSent = (count: number) => waitFor(() => expect(answers).toHaveLength(count));

beforeEach(() => {
	answers.length = 0;
	putGlobals.mockClear();
	resetSaveStoreForTests();
	useToastStore.setState({ toasts: [] });
});

describe("a context-bar variable commit", () => {
	// Mutation check (confirmed): settling from per-call `mutate(next, {
	// onSettled })` callbacks again leaves both of these on "saving".
	it("settles when a second commit in the same scope went out while it was in flight", async () => {
		renderSection();
		commit("example.com", "example.org");
		commit("8080", "9090");
		await putsSent(2);
		expect(useSaveStore.getState().status).toBe("saving");

		await act(async () => {
			answers[0].resolve();
			answers[1].resolve();
		});

		await waitFor(() => expect(useSaveStore.getState().status).toBe("saved"));
		expect(useSaveStore.getState().unsaved.size).toBe(0);
	});

	it("settles after the section that sent it unmounts", async () => {
		const view = renderSection();
		commit("example.com", "example.org");
		await putsSent(1);
		view.unmount();

		await act(async () => {
			answers[0].resolve();
		});

		await waitFor(() => expect(useSaveStore.getState().status).toBe("saved"));
	});

	it("withdraws its report when the PUT fails after the section unmounts", async () => {
		const view = renderSection();
		commit("example.com", "example.org");
		await putsSent(1);
		view.unmount();

		await act(async () => {
			answers[0].reject(new Error("offline"));
		});

		await waitFor(() => expect(useSaveStore.getState().unsaved.size).toBe(0));
		expect(useSaveStore.getState().status).toBe("idle");
		expect(useToastStore.getState().toasts).toHaveLength(1);
	});
});
