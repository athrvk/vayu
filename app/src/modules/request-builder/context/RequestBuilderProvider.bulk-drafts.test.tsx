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
 * A Bulk edit draft belongs to its request, and Send and Save carry it (#3666).
 *
 * The provider holds the draft under `memoryKey`, so it survives the Params /
 * Headers unmount of a sub-tab switch and returns with its request, and the
 * request switch `Shell.tsx` makes (one provider, a new `initialRequest`)
 * never shows it to another request. Send and Save build the request they
 * carry with the draft applied, since `request` will not hold it until the
 * next render.
 *
 * The real provider, `RequestTabs`, panels and `useSaveManager`; only the data
 * hooks are stubbed.
 *
 * Mutation checks, each reverted: make `executeRequest` snapshot `request`
 * instead of `commitBulkDraftsForSend()` and "sends the drafted rows" goes
 * red; drop the `bulkDraftsPatch` in `handleSave` and both save cases go red;
 * file the drafts under one key instead of `memoryKey` and "never shows the
 * draft to the second request" goes red; drop the `shownMemoryKeyRef` guard in
 * `adoptSavedDrafts` and the goodbye-flush case writes A's rows into B; drop
 * the `setHasUnsavedChanges(true)` in `handleSave`'s catch and the failed-save
 * case reads clean.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { TestQueryClient } from "@/test/TestQueryClient";
import { TooltipProvider } from "@/components/ui";
import { useClientSettingsStore } from "@/stores";
import { resetSaveStoreForTests } from "@/stores/save-store";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import { fieldResolverOf } from "@/test/variable-support";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import RequestTabs from "../components/RequestTabs";
import type { MergeableRequestField, RequestState, ResponseState } from "../types";

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
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

type OnSave = (
	request: RequestState,
	changedFields: ReadonlySet<MergeableRequestField>
) => Promise<void>;
type OnExecute = (request: RequestState) => Promise<ResponseState | null>;

const row = (id: string, key: string, value: string) => ({ id, key, value, enabled: true });

const REQUEST_A: Partial<RequestState> = {
	id: "req_a",
	name: "A",
	url: "https://a.test/x?a=1",
	params: [row("a1", "a", "1")],
	headers: [row("ha", "X-A", "1")],
};
const REQUEST_B: Partial<RequestState> = {
	id: "req_b",
	name: "B",
	url: "https://b.test/y?b=2",
	params: [row("b1", "b", "2")],
};

function Probe() {
	const { request, hasUnsavedChanges, updateField, executeRequest, saveRequest } =
		useRequestBuilderContext();
	return (
		<>
			<dl>
				<dd data-testid="url">{request.url}</dd>
				<dd data-testid="param-keys">{request.params.map((p) => p.key).join(",")}</dd>
				<dd data-testid="dirty">{String(hasUnsavedChanges)}</dd>
			</dl>
			<button onClick={() => void executeRequest()}>send</button>
			<button onClick={() => void saveRequest()}>save</button>
			<button onClick={() => updateField("name", "renamed")}>rename</button>
		</>
	);
}
const probed = (testId: string) => screen.getByTestId(testId).textContent;

let onSave: ReturnType<typeof vi.fn<OnSave>>;
let onExecute: ReturnType<typeof vi.fn<OnExecute>>;

function Harness({ initialRequest }: { initialRequest: Partial<RequestState> }) {
	return (
		<TestQueryClient>
			<TooltipProvider>
				<RequestBuilderProvider
					initialRequest={initialRequest}
					collectionId="col_1"
					onSave={onSave}
					onExecute={onExecute}
				>
					<Probe />
					<RequestTabs />
				</RequestBuilderProvider>
			</TooltipProvider>
		</TestQueryClient>
	);
}

const paramsText = () => screen.queryByRole("textbox", { name: "Query parameters" });
const openBulkEdit = () => fireEvent.click(screen.getByRole("radio", { name: /Bulk edit/ }));
const typeDraft = (label: string, value: string) =>
	fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });
const click = (label: string) => act(() => screen.getByText(label).click());
/** Radix activates a trigger on `mousedown`; `click` alone never switches. */
const openTab = (name: RegExp) =>
	fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });

beforeEach(() => {
	resetSaveStoreForTests();
	useTabSelectionStore.getState().clearAll();
	useClientSettingsStore.setState({ autoSave: { enabled: false, delayMs: 5000 } });
	onSave = vi.fn<OnSave>().mockResolvedValue(undefined);
	onExecute = vi.fn<OnExecute>().mockResolvedValue(null);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("a draft and a request switch", () => {
	it("never shows the draft to the second request, and leaves it unchanged", () => {
		const { rerender } = render(<Harness initialRequest={REQUEST_A} />);
		openBulkEdit();
		typeDraft("Query parameters", "a=1\nsecretA=zzz");

		rerender(<Harness initialRequest={REQUEST_B} />);

		expect(paramsText()).toBeNull();
		expect(screen.getByRole("radio", { name: /Table/ })).toBeChecked();
		expect(probed("param-keys")).toBe("b");
		expect(probed("url")).toBe("https://b.test/y?b=2");
		expect(probed("dirty")).toBe("false");
	});

	it("returns to the first request in text mode, holding the draft", () => {
		const { rerender } = render(<Harness initialRequest={REQUEST_A} />);
		openBulkEdit();
		typeDraft("Query parameters", "a=1\nsecretA=zzz");

		rerender(<Harness initialRequest={REQUEST_B} />);
		rerender(<Harness initialRequest={REQUEST_A} />);

		expect(paramsText()).toHaveValue("a=1\nsecretA=zzz");
		// Still a draft: the request itself has not taken the rows.
		expect(probed("param-keys")).toBe("a");
	});
});

describe("a draft and a sub-tab switch", () => {
	it("survives Params -> Headers -> Params", () => {
		render(<Harness initialRequest={REQUEST_A} />);
		openBulkEdit();
		typeDraft("Query parameters", "a=1\nb=2");

		openTab(/^Headers/);
		expect(paramsText()).toBeNull();
		openTab(/^Params/);

		expect(paramsText()).toHaveValue("a=1\nb=2");
	});
});

describe("Send with a draft open", () => {
	it("sends the drafted rows, and the table then shows them", async () => {
		render(<Harness initialRequest={REQUEST_A} />);
		openBulkEdit();
		typeDraft("Query parameters", "a=1\nb=2");

		await click("send");

		expect(onExecute).toHaveBeenCalledTimes(1);
		const sent = onExecute.mock.calls[0][0];
		expect(sent.params.map((p) => p.key)).toEqual(["a", "b"]);
		expect(sent.url).toBe("https://a.test/x?a=1&b=2");
		expect(paramsText()).toBeNull();
		expect(probed("url")).toBe("https://a.test/x?a=1&b=2");
		// A committed edit like any other: autosave has it to write.
		expect(probed("dirty")).toBe("true");
	});

	it("sends a headers draft as well", async () => {
		render(<Harness initialRequest={REQUEST_A} />);
		openTab(/^Headers/);
		openBulkEdit();
		typeDraft("Headers", "X-A: 1\nX-Trace: on");

		await click("send");

		const sent = onExecute.mock.calls[0][0];
		expect(sent.headers.filter((h) => h.key).map((h) => h.key)).toEqual(["X-A", "X-Trace"]);
	});
});

describe("Save with a draft open", () => {
	it("writes the drafted rows on a Save, and keeps the editor open on them", async () => {
		render(<Harness initialRequest={REQUEST_A} />);
		openBulkEdit();
		typeDraft("Query parameters", "a=1\nb=2");

		await click("save");

		expect(onSave).toHaveBeenCalledTimes(1);
		const [saved, fields] = onSave.mock.calls[0];
		expect(saved.params.map((p) => p.key)).toEqual(["a", "b"]);
		expect(saved.url).toBe("https://a.test/x?a=1&b=2");
		expect([...fields].sort()).toEqual(["params", "url"]);
		expect(paramsText()).toHaveValue("a=1\nb=2");
		expect(probed("param-keys")).toBe("a,b");
		// The save carried the commit, so nothing is left unsaved.
		expect(probed("dirty")).toBe("false");
		expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
	});

	it("leaves the drafted rows unsaved when the save fails", async () => {
		onSave.mockRejectedValue(new Error("engine down"));
		render(<Harness initialRequest={REQUEST_A} />);
		openBulkEdit();
		typeDraft("Query parameters", "a=1\nb=2");

		await click("save");

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(probed("param-keys")).toBe("a,b");
		expect(probed("dirty")).toBe("true");
	});

	it("writes the drafted rows when autosave fires for another edit", async () => {
		vi.useFakeTimers();
		useClientSettingsStore.setState({ autoSave: { enabled: true, delayMs: 5000 } });
		render(<Harness initialRequest={REQUEST_A} />);
		await click("rename");
		openBulkEdit();
		typeDraft("Query parameters", "a=1\nb=2");

		await act(() => vi.advanceTimersByTimeAsync(5000));

		expect(onSave).toHaveBeenCalledTimes(1);
		const [saved, fields] = onSave.mock.calls[0];
		expect(saved.name).toBe("renamed");
		expect(saved.params.map((p) => p.key)).toEqual(["a", "b"]);
		expect([...fields].sort()).toEqual(["name", "params", "url"]);
		expect(paramsText()).toHaveValue("a=1\nb=2");
	});

	it("saves a request left with a draft under it, without touching the next", async () => {
		const { rerender } = render(<Harness initialRequest={REQUEST_A} />);
		await click("rename");
		openBulkEdit();
		typeDraft("Query parameters", "a=1\nb=2");

		// Leaving a dirty request flushes its save with its own `handleSave`.
		await act(async () => {
			rerender(<Harness initialRequest={REQUEST_B} />);
		});

		expect(onSave).toHaveBeenCalledTimes(1);
		const [saved] = onSave.mock.calls[0];
		expect(saved.id).toBe("req_a");
		expect(saved.params.map((p) => p.key)).toEqual(["a", "b"]);
		expect(probed("param-keys")).toBe("b");
		expect(probed("url")).toBe("https://b.test/y?b=2");
		expect(probed("dirty")).toBe("false");
	});
});
