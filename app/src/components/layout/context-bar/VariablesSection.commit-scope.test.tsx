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
 * Where a context-bar edit lands, and what it carries when it gets there.
 *
 * The bar displays the definition the *resolver* picked and used to write back
 * to one it re-derived itself, with a different rule: the resolver counts an
 * absent `enabled` as enabled (D17), the bar's chain walk wanted it truthy. A
 * leaf definition with no `enabled` key therefore showed on screen while an
 * ancestor's definition took the write - silently, cross-collection, and with
 * the typed text still sitting in the input looking committed.
 *
 * The payload had the matching problem in time rather than space: it was spread
 * from the render-closure copy of the whole map, and the transport replaces the
 * map wholesale, so a second blur re-sent the first edit's pre-edit value.
 *
 * Every case here is mutation-checked - each one reddens if the commit goes back
 * to re-deriving its target or to the render-time snapshot.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VariablesSection } from "./VariablesSection";
import { TooltipProvider } from "@/components/ui";
import { queryKeys } from "@/queries/keys";
import { useToastStore } from "@/stores/toast-store";
import { useSaveStore } from "@/stores/save-store";
import type { Collection, Environment, ResolvedVariable, VariableValue } from "@/types";

type Handlers = { onError: (e: unknown) => void; onSettled: () => void };
type VariableMap = Record<string, VariableValue>;

const globalsMutate = vi.fn();
const environmentMutate = vi.fn();
const collectionMutate = vi.fn();

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: { id: "req_1", collectionId: "col_leaf" } }),
	useUpdateGlobalsMutation: () => ({ mutate: globalsMutate }),
	useUpdateEnvironmentMutation: () => ({ mutate: environmentMutate }),
	useUpdateCollectionMutation: () => ({ mutate: collectionMutate }),
}));

/** The resolver's verdict for this render - the winner, and which source it won from. */
let resolved: Record<string, ResolvedVariable> = {};

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ getAllVariables: () => resolved }),
}));

// The section reads only the save store from `@/stores`; the real one is kept
// so the in-flight-commit case exercises the actual registry.
vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	return { useSaveStore: saveStore.useSaveStore };
});

/** The tab every section is handed. */
const TAB = { id: "t1", type: "request", entityId: "req_1" } as const;

const def = (value: string, extra: Partial<VariableValue> = {}): VariableValue => ({
	value,
	enabled: true,
	...extra,
});

const collection = (id: string, variables: VariableMap, parentId?: string): Collection => ({
	id,
	name: id,
	description: "",
	parentId,
	order: 0,
	variables,
	auth: { mode: "noauth" },
	preRequestScript: "",
	postRequestScript: "",
	createdAt: "",
	updatedAt: "",
});

const environment = (id: string, variables: VariableMap): Environment => ({
	id,
	name: id,
	description: "",
	variables,
	isActive: false,
	createdAt: "",
	updatedAt: "",
});

/**
 * The leaf defines `apiKey` with **no `enabled` key** and the ancestor defines
 * it enabled - the exact shape the engine stores verbatim and D17 resolves to
 * the leaf. The old truthy-`enabled` walk skipped the leaf and wrote the
 * ancestor. The cast is the point of the fixture: `enabled` is required by the
 * type and absent in the stored blob, which is what D17 exists to describe.
 */
const collections: Collection[] = [
	collection("col_root", { apiKey: def("ancestor-key", { secret: true }) }),
	collection("col_leaf", { apiKey: { value: "leaf-key" } as VariableValue }, "col_root"),
];

const environments: Environment[] = [
	environment("env_a", { token: def("a-token") }),
	environment("env_b", { token: def("b-token") }),
];

function seed(client: QueryClient) {
	client.setQueryData(queryKeys.globals.all, {
		id: "globals",
		updatedAt: "",
		variables: {
			host: def("example.com", { secret: false, type: "string" }),
			port: def("8080", { type: "number" }),
		},
	});
	client.setQueryData(queryKeys.environments.list(), environments);
	client.setQueryData(queryKeys.collections.list(), collections);
}

function renderSection() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	seed(client);
	// The header's close button is a `TooltipIconButton`, which needs the provider
	// the app mounts once in `main.tsx`.
	const view = render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<VariablesSection tab={TAB} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return { client, ...view };
}

function editAndBlur(input: HTMLInputElement, value: string) {
	act(() => {
		fireEvent.change(input, { target: { value } });
		fireEvent.blur(input);
	});
}

function inputFor(displayValue: string): HTMLInputElement {
	return screen.getByDisplayValue(displayValue) as HTMLInputElement;
}

beforeEach(() => {
	globalsMutate.mockReset();
	environmentMutate.mockReset();
	collectionMutate.mockReset();
	useToastStore.setState({ toasts: [] });
	useSaveStore.getState().reset();
	resolved = {};
});

describe("VariablesSection - the commit target is the resolver's winner", () => {
	it("writes a global edit into the globals map", () => {
		resolved = { host: { value: "example.com", scope: "global" } };

		renderSection();
		editAndBlur(inputFor("example.com"), "example.org");

		expect(globalsMutate).toHaveBeenCalledTimes(1);
		expect(globalsMutate.mock.calls[0][0].variables.host.value).toBe("example.org");
	});

	it("writes an environment edit into the source environment, not the active one", () => {
		// The winner came from `env_b`. Nothing in the commit path may consult the
		// session's active environment - the two are the same id only by luck.
		resolved = { token: { value: "b-token", scope: "environment", sourceId: "env_b" } };

		renderSection();
		editAndBlur(inputFor("b-token"), "b-token-2");

		expect(environmentMutate).toHaveBeenCalledTimes(1);
		expect(environmentMutate.mock.calls[0][0].id).toBe("env_b");
		expect(environmentMutate.mock.calls[0][0].variables.token.value).toBe("b-token-2");
	});

	it("writes a collection edit into the definition D17 resolved, not an enabled ancestor", () => {
		// `col_leaf`'s definition has no `enabled` key; `col_root`'s has
		// `enabled: true`. Re-deriving with a truthy test picks `col_root` - and
		// `col_root`'s definition is `secret: true`, so the old path let a
		// non-secret input overwrite a secret one in another collection.
		resolved = { apiKey: { value: "leaf-key", scope: "collection", sourceId: "col_leaf" } };

		renderSection();
		editAndBlur(inputFor("leaf-key"), "leaf-key-2");

		expect(collectionMutate).toHaveBeenCalledTimes(1);
		expect(collectionMutate.mock.calls[0][0].id).toBe("col_leaf");
		expect(collectionMutate.mock.calls[0][0].variables.apiKey.value).toBe("leaf-key-2");
		// The ancestor's secret is untouched.
		expect(collections[0].variables.apiKey.value).toBe("ancestor-key");
	});

	it("refuses out loud when the source environment is gone", () => {
		resolved = { token: { value: "b-token", scope: "environment", sourceId: "env_deleted" } };

		renderSection();
		const input = inputFor("b-token");
		editAndBlur(input, "b-token-2");

		expect(environmentMutate).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts).toHaveLength(1);
		expect(input.value).toBe("b-token");
	});

	it("refuses out loud when the source collection no longer holds the name", () => {
		resolved = { ghost: { value: "gone", scope: "collection", sourceId: "col_leaf" } };

		renderSection();
		const input = inputFor("gone");
		editAndBlur(input, "still-here");

		expect(collectionMutate).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts).toHaveLength(1);
		expect(input.value).toBe("gone");
	});

	it("refuses a non-global winner that names no source at all", () => {
		// The resolver always emits `sourceId` for these scopes. If it ever stops,
		// the commit must refuse rather than pick something.
		resolved = { token: { value: "b-token", scope: "environment" } };

		renderSection();
		editAndBlur(inputFor("b-token"), "b-token-2");

		expect(environmentMutate).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts).toHaveLength(1);
	});

	it("keeps no unguarded parentId walk in the component", () => {
		// `buildLeafFirstChain` re-implemented `buildCollectionChain` without its
		// cycle guard, so a bad database froze the window on the first blur. The
		// fix is that the component walks nothing at all - it is handed the winner.
		// The guard reads the file it names: a scan of an empty string passes
		// vacuously, which is how one of these shipped green for weeks.
		const source = readFileSync(join(__dirname, "VariablesSection.tsx"), "utf8");
		expect(source.length).toBeGreaterThan(1000);
		expect(source).not.toContain("parentId");
	});
});

describe("VariablesSection - the commit payload", () => {
	it("carries untouched siblings verbatim and changes only the edited value", () => {
		resolved = {
			host: { value: "example.com", scope: "global" },
			port: { value: "8080", scope: "global" },
		};

		renderSection();
		editAndBlur(inputFor("example.com"), "example.org");

		const sent = globalsMutate.mock.calls[0][0].variables;
		expect(sent.port).toEqual(def("8080", { type: "number" }));
		expect(sent.host).toEqual(def("example.org", { secret: false, type: "string" }));
	});

	it("reads the cache at commit time, so a second blur does not revert the first", () => {
		// Both mutations are left in flight - neither `onSettled` nor `onError` is
		// called. Built from the render closure, the second payload would carry
		// `example.com`, the value the first commit just replaced.
		resolved = {
			host: { value: "example.com", scope: "global" },
			port: { value: "8080", scope: "global" },
		};

		renderSection();
		editAndBlur(inputFor("example.com"), "example.org");
		editAndBlur(inputFor("8080"), "9090");

		expect(globalsMutate).toHaveBeenCalledTimes(2);
		const second = globalsMutate.mock.calls[1][0].variables;
		expect(second.host.value).toBe("example.org");
		expect(second.port.value).toBe("9090");
	});

	it("restores only the edited name when the engine refuses", () => {
		resolved = {
			host: { value: "example.com", scope: "global" },
			port: { value: "8080", scope: "global" },
		};

		const { client } = renderSection();
		globalsMutate.mockImplementation((_payload: unknown, handlers: Handlers) => {
			handlers.onError(new Error("value must not be empty"));
			handlers.onSettled();
		});

		const input = inputFor("example.com");
		editAndBlur(input, "example.org");

		const cached = client.getQueryData<{ variables: Record<string, VariableValue> }>(
			queryKeys.globals.all
		);
		expect(cached?.variables.host.value).toBe("example.com");
		expect(cached?.variables.port.value).toBe("8080");
		expect(useToastStore.getState().toasts[0].message).toBe("value must not be empty");
		expect(input.value).toBe("example.com");
	});
});

describe("VariablesSection - the input itself", () => {
	it("discards on Escape and commits on Enter", () => {
		resolved = { host: { value: "example.com", scope: "global" } };

		renderSection();
		const input = inputFor("example.com");

		act(() => {
			fireEvent.change(input, { target: { value: "throwaway" } });
			fireEvent.keyDown(input, { key: "Escape" });
			fireEvent.blur(input);
		});
		expect(globalsMutate).not.toHaveBeenCalled();
		expect(input.value).toBe("example.com");

		act(() => {
			fireEvent.change(input, { target: { value: "example.org" } });
			fireEvent.keyDown(input, { key: "Enter" });
			fireEvent.blur(input);
		});
		expect(globalsMutate).toHaveBeenCalledTimes(1);
	});

	it("masks a secret read-only and cannot commit it", () => {
		resolved = {
			apiKey: { value: "leaf-key", scope: "collection", sourceId: "col_leaf", secret: true },
		};

		renderSection();
		const masked = screen.getByDisplayValue("••••••") as HTMLInputElement;

		expect(masked.readOnly).toBe(true);
		expect(screen.queryByDisplayValue("leaf-key")).toBeNull();

		act(() => {
			fireEvent.blur(masked);
		});
		expect(collectionMutate).not.toHaveBeenCalled();
	});

	it("remounts the input when the winner's source changes under the same value", () => {
		// Same displayed string, different source: on a value-only key the DOM node
		// survived and the next blur wrote into whichever definition had just won.
		resolved = { token: { value: "same", scope: "environment", sourceId: "env_a" } };
		const { rerender, client } = renderSection();
		const before = inputFor("same");

		resolved = { token: { value: "same", scope: "environment", sourceId: "env_b" } };
		rerender(
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<VariablesSection tab={TAB} />
				</TooltipProvider>
			</QueryClientProvider>
		);

		expect(inputFor("same")).not.toBe(before);
	});
});

describe("VariablesSection - an in-flight commit and the save store", () => {
	it("is awaited by the quit-time flush and reports through the Dock status", async () => {
		resolved = { host: { value: "example.com", scope: "global" } };

		let settle: (() => void) | null = null;
		globalsMutate.mockImplementation((_payload: unknown, handlers: Handlers) => {
			settle = handlers.onSettled;
		});

		renderSection();
		editAndBlur(inputFor("example.com"), "example.org");

		expect(useSaveStore.getState().status).toBe("saving");

		let flushed = false;
		const flush = useSaveStore
			.getState()
			.flushAll()
			.then(() => {
				flushed = true;
			});

		// A macrotask, not a microtask: `flushAll` with nothing registered resolves
		// within a couple of ticks, and a shorter wait passes either way - which is
		// how a missing registration would ship green.
		await new Promise((r) => setTimeout(r, 0));
		expect(flushed).toBe(false);

		await act(async () => {
			settle?.();
			await flush;
		});

		expect(flushed).toBe(true);
		expect(useSaveStore.getState().status).toBe("saved");
	});
});
