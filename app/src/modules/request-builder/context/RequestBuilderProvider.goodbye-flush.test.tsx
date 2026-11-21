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
 * A save of the request left behind writes nothing into the request shown
 * next (#3730).
 *
 * `useSaveManager` flushes the dirty request A from a passive effect's cleanup
 * when the builder is handed B, with A's own `handleSave`, and the save runs a
 * microtask later, on a provider that already shows B. Whatever that save
 * records for itself (the values it sent, the fields it settled, the dirty
 * flag) belongs to A; written into the provider's state it would land in B's.
 *
 * The real provider and `useSaveManager`; only the data hooks are stubbed. The
 * save is held open, so the cases decide whether B's edits land before or
 * after it settles. B's sent-values memory is read the way the merge reads
 * it: a fetched value one of B's saves sent is an echo, any other value on a
 * touched field is a conflict.
 *
 * Mutation checks, each reverted: drop the `isShown` guard on the
 * `setRecentSends` append in `handleSave` and "an outside write of what A
 * sent" goes red (it reads as B's echo, no conflict); drop it from the catch's
 * `setHasUnsavedChanges(true)` and the failed-save case reads B dirty. The
 * settled tail is held twice, since the switch's reset also moves the
 * generation: make `settled` `true` and "after A's save settles" goes red (B's
 * name is no longer touched); make it `isShown()` alone and only A's own
 * typed-through case does. Invert the guard and both "A's own save" cases go
 * red.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { TestQueryClient } from "@/test/TestQueryClient";
import { useClientSettingsStore } from "@/stores";
import { resetSaveStoreForTests } from "@/stores/save-store";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import { fieldResolverOf } from "@/test/variable-support";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import type { MergeableRequestField, RequestState } from "../types";

vi.mock("@/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks")>()),
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		resolveField: fieldResolverOf((s: string) => s),
		resolveObject: (o: unknown) => o,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
}));

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useElementKindsQuery: () => ({ data: [] }),
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: () => [],
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
	useConfigQuery: () => ({ data: { entries: [] } }),
	useRequestDefaultsQuery: () => ({ data: { headers: [] } }),
	useRequestQuery: () => ({ data: undefined }),
}));

type OnSave = (
	request: RequestState,
	changedFields: ReadonlySet<MergeableRequestField>
) => Promise<void>;

const REQUEST_A: Partial<RequestState> = { id: "req_a", name: "A", url: "https://a.test" };
const REQUEST_B: Partial<RequestState> = { id: "req_b", name: "B", url: "https://b.test" };

function Probe() {
	const { request, hasUnsavedChanges, fieldConflicts, updateField, saveRequest, setBulkDraft } =
		useRequestBuilderContext();
	return (
		<>
			<dl>
				<dd data-testid="id">{request.id}</dd>
				<dd data-testid="name">{request.name}</dd>
				<dd data-testid="dirty">{String(hasUnsavedChanges)}</dd>
				<dd data-testid="conflicts">{JSON.stringify(fieldConflicts)}</dd>
			</dl>
			<button onClick={() => updateField("name", "sent by A")}>name A</button>
			<button onClick={() => updateField("name", "typed in B")}>name B</button>
			<button onClick={() => void saveRequest()}>save</button>
			<button onClick={() => setBulkDraft("params", { text: "a=1", opened: "" })}>
				draft A
			</button>
		</>
	);
}
const probed = (testId: string) => screen.getByTestId(testId).textContent;
const click = (label: string) => act(() => screen.getByText(label).click());

/** Each save the test holds open, oldest first, until `finish` or `fail`. */
let held: { resolve: () => void; reject: (error: Error) => void }[];
let onSave: ReturnType<typeof vi.fn<OnSave>>;

function Harness({ initialRequest }: { initialRequest: Partial<RequestState> }) {
	return (
		<TestQueryClient>
			<RequestBuilderProvider
				initialRequest={initialRequest}
				collectionId="col_1"
				onSave={onSave}
			>
				<Probe />
			</RequestBuilderProvider>
		</TestQueryClient>
	);
}

const finish = () =>
	act(async () => {
		held.shift()?.resolve();
	});
const fail = () =>
	act(async () => {
		held.shift()?.reject(new Error("engine down"));
	});

beforeEach(() => {
	resetSaveStoreForTests();
	useTabSelectionStore.getState().clearAll();
	useClientSettingsStore.setState({ autoSave: { enabled: false, delayMs: 5000 } });
	held = [];
	onSave = vi.fn<OnSave>(
		() =>
			new Promise<void>((resolve, reject) => {
				held.push({ resolve, reject });
			})
	);
});

afterEach(() => {
	cleanup();
});

/** Rename A, then switch to B: the switch flushes A's save, held open. */
async function leaveDirtyA() {
	const view = render(<Harness initialRequest={REQUEST_A} />);
	await click("name A");
	await act(async () => {
		view.rerender(<Harness initialRequest={REQUEST_B} />);
	});
	expect(onSave).toHaveBeenCalledTimes(1);
	expect(onSave.mock.calls[0][0].id).toBe("req_a");
	expect(probed("id")).toBe("req_b");
	/** Hand B a fetched copy carrying `name`, as the detail cache does. */
	const deliverB = (name: string) =>
		act(() => view.rerender(<Harness initialRequest={{ ...REQUEST_B, name }} />));
	return { deliverB };
}

describe("a goodbye flush of A that settles after the switch to B", () => {
	it("leaves B clean and its baseline untouched", async () => {
		const { deliverB } = await leaveDirtyA();
		await finish();

		expect(probed("name")).toBe("B");
		expect(probed("dirty")).toBe("false");
		// Untouched in B, so an outside write is adopted silently. A's saved
		// value is the probe: had A's save moved B's baseline to it, the write
		// below would read as no change and B's name would stay "B".
		deliverB("sent by A");
		expect(probed("name")).toBe("sent by A");
		expect(probed("conflicts")).toBe("{}");
	});

	it("does not take an outside write of what A sent as B's echo", async () => {
		const { deliverB } = await leaveDirtyA();
		await click("name B");
		await finish();

		deliverB("sent by A");

		expect(probed("conflicts")).toBe(JSON.stringify({ name: "sent by A" }));
		expect(probed("name")).toBe("typed in B");
	});

	it("keeps B's own edit touched and dirty after A's save settles", async () => {
		const { deliverB } = await leaveDirtyA();
		await click("name B");
		await finish();

		expect(probed("dirty")).toBe("true");
		deliverB("theirs");
		expect(probed("conflicts")).toBe(JSON.stringify({ name: "theirs" }));
		expect(probed("name")).toBe("typed in B");
	});
});

describe("a save of A started on screen that fails after the switch to B", () => {
	it("leaves B clean, though A's save had adopted a Bulk edit draft", async () => {
		const view = render(<Harness initialRequest={REQUEST_A} />);
		await click("name A");
		await click("draft A");
		await click("save");
		await act(async () => {
			view.rerender(<Harness initialRequest={REQUEST_B} />);
		});
		expect(probed("dirty")).toBe("false");

		await fail();

		expect(probed("id")).toBe("req_b");
		expect(probed("dirty")).toBe("false");
		// The goodbye flush queued behind it, settled so nothing is left open.
		await finish();
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(probed("dirty")).toBe("false");
	});
});

describe("A's own save while A is on screen", () => {
	it("records what it sent and settles A", async () => {
		const view = render(<Harness initialRequest={REQUEST_A} />);
		await click("name A");
		await click("save");
		expect(onSave).toHaveBeenCalledTimes(1);
		await finish();

		expect(probed("dirty")).toBe("false");
		// No longer touched, so an outside write is adopted silently.
		act(() => view.rerender(<Harness initialRequest={{ ...REQUEST_A, name: "theirs" }} />));
		expect(probed("name")).toBe("theirs");
		expect(probed("conflicts")).toBe("{}");
	});

	it("recognises its echo while A types on through the save", async () => {
		const view = render(<Harness initialRequest={REQUEST_A} />);
		await click("name A");
		await click("save");
		await click("name B");

		act(() => view.rerender(<Harness initialRequest={{ ...REQUEST_A, name: "sent by A" }} />));

		expect(probed("conflicts")).toBe("{}");
		expect(probed("name")).toBe("typed in B");
		await finish();
		expect(probed("dirty")).toBe("true");
	});
});
