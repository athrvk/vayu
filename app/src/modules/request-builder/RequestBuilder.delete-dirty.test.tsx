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
 * Deleting a request, or the collection above it, while its tab holds an
 * unsaved edit (#3444). The delete awaits the engine, then closes the tab, and
 * the tab's unmount flushes its draft: that PUT answered 404, raised "Couldn't
 * save - Request not found", and left a dead retry context behind, so the Dock
 * stayed on "Not saved" and a quit warned about an edit nobody could save.
 *
 * Real from the tree's handlers to the save store; only the engine's answers
 * (`apiService`) are stubbed, and `updateRequest` answers a deleted row with
 * the 404 the engine gives.
 */

import type { ReactNode } from "react";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { ApiError } from "@/services/http-client";
import {
	useClientSettingsStore,
	useEngineStore,
	useSaveStore,
	useTabsStore,
	useToastStore,
} from "@/stores";
import { resetSaveStoreForTests } from "@/stores/save-store";
import { useTreeCrud } from "@/modules/collections/useTreeCrud";
import type { Collection, Request, RequestSummary } from "@/types";
import { useRequestBuilderContext } from "./context/RequestBuilderContext";

/** The edit the cases make, and what they read back off the draft. */
function DraftProbe() {
	const { request, updateField } = useRequestBuilderContext();
	return (
		<>
			<span data-testid="description">{request.description}</span>
			<button onClick={() => updateField("description", "my draft")}>type description</button>
		</>
	);
}

// The layout renders Monaco and the response tree; the draft is the subject.
vi.mock("./components/RequestBuilderLayout", () => ({ default: () => <DraftProbe /> }));

const { default: RequestBuilder } = await import("./index");

const STORED = {
	id: "req_1",
	collectionId: "col_1",
	name: "Get user",
	description: "stored description",
	method: "GET",
	url: "https://api.test/v1",
	params: [],
	headers: [],
	body: { mode: "none" },
	auth: { mode: "none" },
	elements: [],
	followRedirects: true,
	maxRedirects: 10,
	httpVersion: "auto",
	verifySSL: true,
	stream: false,
	order: 0,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as Request;

const COLLECTIONS = [{ id: "col_1", name: "Acme", order: 0 }] as Collection[];
const ROWS = new Map<string, RequestSummary[]>([
	["col_1", [{ id: "req_1", collectionId: "col_1", name: "Get user" } as RequestSummary]],
]);

/** The engine's row for `req_1` is gone while this is true. */
let deleted: boolean;
let updateRequest: MockInstance<typeof apiService.updateRequest>;

const notFound = () => new ApiError(404, "not_found", "Request not found");

beforeEach(() => {
	deleted = false;
	// Every other read the pane makes waits forever: they are not the subject.
	vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
	vi.spyOn(apiService, "getRequest").mockImplementation(async () => {
		if (deleted) throw notFound();
		return { ...STORED };
	});
	updateRequest = vi.spyOn(apiService, "updateRequest").mockImplementation(async (data) => {
		if (deleted) throw notFound();
		return { ...STORED, ...data } as Request;
	});
	vi.spyOn(apiService, "deleteRequest").mockImplementation(async () => {
		deleted = true;
	});
	vi.spyOn(apiService, "deleteCollection").mockImplementation(async () => {
		deleted = true;
	});
	// The edit must wait for the delete, not race it as an autosave.
	useClientSettingsStore.getState().setAutoSave({ enabled: false });
	useToastStore.setState({ toasts: [] });
	// `closeTab` refuses a dirty tab while the engine is unreachable (#1489).
	useEngineStore.getState().setEngineStatus("connected");
	resetSaveStoreForTests();
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Get user" } as never],
		activeTabId: "t1",
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** What `Shell` does: the builder is mounted while a request tab is active. */
function Pane() {
	const active = useTabsStore((s) => s.openTabs.find((t) => t.id === s.activeTabId));
	return active?.type === "request" ? <RequestBuilder /> : null;
}

/** The pane and the tree's handlers, over one query client. */
function renderPaneAndTree() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	render(<Pane />, { wrapper });
	const tree = renderHook(
		() =>
			useTreeCrud({
				collections: COLLECTIONS,
				requestsByCollection: ROWS,
				getRequestsByCollection: (id) => ROWS.get(id) ?? [],
				revealEntity: vi.fn(),
			}),
		{ wrapper }
	);
	return tree.result;
}

/** The pane has read `req_1` and the user has typed into it. */
async function typeIntoOpenRequest() {
	await screen.findByText("stored description");
	act(() => screen.getByText("type description").click());
	expect(screen.getByTestId("description").textContent).toBe("my draft");
	expect(useSaveStore.getState().contexts.get("request-req_1")?.hasPendingChanges).toBe(true);
}

/** Opens the confirm dialog's target and confirms it, as the dialog's button does. */
async function confirmDelete(
	tree: ReturnType<typeof renderPaneAndTree>,
	open: (handlers: ReturnType<typeof renderPaneAndTree>["current"]["handlers"]) => void
) {
	act(() => open(tree.current.handlers));
	act(() => tree.current.panel.confirmDelete());
	await waitFor(() => expect(tree.current.panel.deleteConfirm).toBeNull());
}

/** No trace of the deleted request's edit anywhere a user or a quit would see it. */
async function expectNothingLeftUnsaved() {
	const { status, contexts, unsaved, flushAll } = useSaveStore.getState();
	expect(updateRequest).not.toHaveBeenCalled();
	expect(useToastStore.getState().toasts.filter((t) => t.variant === "error")).toEqual([]);
	expect(status).not.toBe("error");
	expect(contexts.has("request-req_1")).toBe(false);
	expect(unsaved.has("request-req_1")).toBe(false);
	expect(await flushAll()).toEqual({ saved: 0, failed: 0, pending: 0 });
}

describe("deleting a request that has an unsaved edit", () => {
	it("drops the edit instead of saving it into the deleted row", async () => {
		const tree = renderPaneAndTree();
		await typeIntoOpenRequest();

		await confirmDelete(tree, (h) => h.onRequestDeleteClick("req_1", "Get user"));

		expect(useTabsStore.getState().openTabs).toEqual([]);
		await expectNothingLeftUnsaved();
	});

	it("drops the edit when the collection above the request is deleted", async () => {
		const tree = renderPaneAndTree();
		await typeIntoOpenRequest();

		await confirmDelete(tree, (h) => h.onCollectionDeleteClick("col_1", "Acme"));

		expect(useTabsStore.getState().openTabs).toEqual([]);
		await expectNothingLeftUnsaved();
	});

	// Undo brings the same id back: its next edit is a real one and must be sent.
	it("saves a restored request's edit when its tab is closed again", async () => {
		const tree = renderPaneAndTree();
		await typeIntoOpenRequest();
		await confirmDelete(tree, (h) => h.onRequestDeleteClick("req_1", "Get user"));

		deleted = false;
		act(() => useTabsStore.getState().openTab({ type: "request", entityId: "req_1" }));
		await typeIntoOpenRequest();
		act(() => useTabsStore.getState().closeTabsForEntities(["req_1"]));

		await waitFor(() => expect(updateRequest).toHaveBeenCalledTimes(1));
		expect(updateRequest.mock.calls[0][0]).toMatchObject({
			id: "req_1",
			description: "my draft",
		});
		await waitFor(() =>
			expect(useSaveStore.getState().unsaved.has("request-req_1")).toBe(false)
		);
		expect(useToastStore.getState().toasts.filter((t) => t.variant === "error")).toEqual([]);
	});
});

describe("closing a tab whose request was deleted elsewhere", () => {
	// The backstop: nothing marked the id removed, so the flush is sent and the
	// engine's 404 is the only word on it. The toast already went out; what must
	// not outlive it is a retry context that can never land.
	it("leaves no retry context behind when the flush is answered 404", async () => {
		renderPaneAndTree();
		await typeIntoOpenRequest();
		deleted = true;

		act(() => useTabsStore.getState().closeTab("t1"));

		await waitFor(() => expect(updateRequest).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(useSaveStore.getState().unsaved.has("request-req_1")).toBe(false)
		);
		const { contexts, status, flushAll } = useSaveStore.getState();
		expect(contexts.has("request-req_1")).toBe(false);
		expect(status).not.toBe("error");
		expect(await flushAll()).toEqual({ saved: 0, failed: 0, pending: 0 });
	});

	it("still keeps the edit for a retry when the flush fails for any other reason", async () => {
		renderPaneAndTree();
		await typeIntoOpenRequest();
		updateRequest.mockRejectedValue(new ApiError(500, "internal", "Disk error"));

		act(() => useTabsStore.getState().closeTab("t1"));

		await waitFor(() =>
			expect(useSaveStore.getState().contexts.has("request-req_1")).toBe(true)
		);
		expect(useSaveStore.getState().status).toBe("error");
	});
});
