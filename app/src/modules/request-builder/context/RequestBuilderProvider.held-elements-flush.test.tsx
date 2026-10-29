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
 * A save that holds an invalid elements list back (#3048) still sends the rest
 * of the request, and must then settle: the Dock reads "Unsaved changes", the
 * quit flush counts the request pending, and nothing re-sends the URL that
 * already landed. The provider's own contract is
 * `RequestBuilderProvider.incomplete-element.test.tsx`, against a stub save
 * manager; this file runs the real `useSaveManager` and save store, so the
 * autosave re-arm the partial save's baseline move causes is in the picture.
 *
 * Mutation checks, each reddening both cases: record "elements" as saved after
 * the partial PUT (`recordSaved(request, changedFields)` in `handleSave`) and
 * the retry reads the request clean; drop the `SaveBlockedError` thrown after
 * it and the save reports "saved"; restore the old throw-before-`onSave` and
 * no PUT is made at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { TestQueryClient } from "@/test/TestQueryClient";
import { TIMING } from "@/config/timing";
import { useClientSettingsStore } from "@/stores";
import { useSaveStore, type FlushTally } from "@/stores/save-store";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import type { RequestState, MergeableRequestField } from "../types";
import type { ElementKindSchema } from "@/types";

type OnSave = (
	request: RequestState,
	changedFields: ReadonlySet<MergeableRequestField>
) => Promise<void>;

const PACING_KIND: ElementKindSchema = {
	kind: "timer.pacing",
	version: 1,
	label: "Pacing",
	description: "",
	category: "timer",
	hotPathClass: "declarative",
	collectionOnly: false,
	configSchema: {
		type: "object",
		required: ["everyMs"],
		properties: { everyMs: { type: "integer", minimum: 1 } },
	},
	phases: [],
};

vi.mock("@/hooks", async () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		resolveObject: (o: unknown) => o,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
	useSaveManager: (await import("@/hooks/useSaveManager")).useSaveManager,
}));

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: () => [],
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
	useConfigQuery: () => ({ data: { entries: [] } }),
	useElementKindsQuery: () => ({ data: [PACING_KIND] }),
}));

function EditsProbe() {
	const { updateField } = useRequestBuilderContext();
	return (
		<>
			<button
				onClick={() =>
					updateField("elements", [
						{ id: "el_1", kind: "timer.pacing", enabled: true, config: { everyMs: 0 } },
					])
				}
			>
				set a cadence of 0
			</button>
			<button onClick={() => updateField("url", "https://api.test/edited")}>
				edit the url
			</button>
		</>
	);
}

function mount(onSave: OnSave) {
	render(
		<TestQueryClient>
			<RequestBuilderProvider
				initialRequest={{ id: "req_1", name: "Req", url: "https://api.test/a" }}
				collectionId="col_1"
				onSave={onSave}
			>
				<EditsProbe />
			</RequestBuilderProvider>
		</TestQueryClient>
	);
}

const click = (label: string) => act(() => screen.getByText(label).click());
const sentFields = (onSave: ReturnType<typeof vi.fn<OnSave>>) =>
	[...(onSave.mock.calls[0][1] as ReadonlySet<string>)].sort();

beforeEach(() => {
	useSaveStore.getState().reset();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("a request whose elements are held back while the rest is saved", () => {
	it("autosaves the URL once, then rests at pending without re-sending it", async () => {
		vi.useFakeTimers();
		useClientSettingsStore.setState({ autoSave: { enabled: true, delayMs: 5000 } });
		const onSave = vi.fn<OnSave>().mockResolvedValue(undefined);
		mount(onSave);
		click("set a cadence of 0");
		click("edit the url");

		await act(() => vi.advanceTimersByTimeAsync(5000));
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(sentFields(onSave)).toEqual(["url"]);

		// Past the longest retry backoff: a held-back list is not a failure, so
		// nothing retries it, and the URL is not sent a second time.
		await act(() => vi.advanceTimersByTimeAsync(TIMING.SAVE_RETRY_MAX_DELAY_MS * 2));
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(useSaveStore.getState().status).toBe("pending");
		expect(useSaveStore.getState().contexts.get("request-req_1")?.hasPendingChanges).toBe(true);
	});

	it("is counted pending by the quit flush, and a second flush sends nothing", async () => {
		useClientSettingsStore.setState({ autoSave: { enabled: false, delayMs: 5000 } });
		const onSave = vi.fn<OnSave>().mockResolvedValue(undefined);
		mount(onSave);
		click("set a cadence of 0");
		click("edit the url");

		let first: FlushTally | undefined;
		await act(async () => {
			first = await useSaveStore.getState().flushAll();
		});
		expect(first).toEqual({ saved: 0, failed: 0, pending: 1 });
		expect(sentFields(onSave)).toEqual(["url"]);

		let second: FlushTally | undefined;
		await act(async () => {
			second = await useSaveStore.getState().flushAll();
		});
		expect(second).toEqual({ saved: 0, failed: 0, pending: 1 });
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(useSaveStore.getState().status).toBe("pending");
	});
});
