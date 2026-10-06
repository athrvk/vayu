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
 * "Save to request" on a run an agent started that no saved request stands
 * behind (issue #1817).
 *
 * Such a run has no request to overwrite, so the header's Save creates one: the
 * primary action, through `useNewRequest` (the real hook - which collection it
 * lands in is its rule, and the picker is its dialog). Every other run keeps
 * the header it had. Both branches are asserted, because "the button appears"
 * proves nothing about the runs it must not appear on.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import DesignRunView from "./DesignRunView";
import { useSessionStore, useTabsStore, useToastStore } from "@/stores";
import type { Run, Request, RunOrigin } from "@/types";

const mocks = vi.hoisted(() => ({
	createRequest: vi.fn(),
	createCollection: vi.fn(),
	updateRequest: vi.fn(),
	liveRequest: null as unknown,
	collections: [] as { id: string; name: string }[],
}));

vi.mock("@/hooks/useEngine", () => ({
	useEngine: () => ({ executeRequest: vi.fn(), composeRequest: vi.fn() }),
}));

vi.mock("@/queries", async () => {
	const actual = await vi.importActual<typeof import("@/queries")>("@/queries");
	return {
		...actual,
		useRequestQuery: () => ({
			data: mocks.liveRequest ?? undefined,
			isLoading: false,
			isError: false,
			error: null,
			refetch: vi.fn(),
		}),
		useCollectionAncestors: () => [],
		useCollectionsQuery: () => ({ data: mocks.collections, isLoading: false }),
		useCreateRequestMutation: () => ({ mutateAsync: mocks.createRequest }),
		useCreateCollectionMutation: () => ({ mutateAsync: mocks.createCollection }),
		useUpdateRequestMutation: () => ({ mutateAsync: mocks.updateRequest, isPending: false }),
		useSetRunBaselineMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	};
});

// Monaco does not run under jsdom.
vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: ({ value }: { value: string }) => <pre data-testid="code">{value}</pre>,
}));

function designRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_1",
		type: "design",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_000_300,
		requestId: null,
		environmentId: null,
		origin: { kind: "mcp", client: "claude-ai" },
		configSnapshot: {
			method: "POST",
			url: "https://api.example.test/users?page=2",
			body: { mode: "json", content: '{"a":1}' },
			auth: { mode: "bearer" },
		},
		result: {
			timestamp: 1_750_000_000_000,
			statusCode: 200,
			statusText: "OK",
			latencyMs: 12,
			trace: {
				request: {
					method: "POST",
					url: "https://api.example.test/users?page=2",
					headers: { "X-Plain": "visible" },
					body: '{"a":1}',
				},
				response: { headers: {}, body: "{}" },
			},
		},
		...overrides,
	} as Run;
}

function renderView(run: Run) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<DesignRunView run={run} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

const saveButtons = () => screen.queryAllByRole("button", { name: /^save to request$/i });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.liveRequest = null;
	mocks.collections = [
		{ id: "c1", name: "Alpha" },
		{ id: "c2", name: "Beta" },
	];
	mocks.createRequest.mockResolvedValue({ id: "req_new", collectionId: "c2" });
	mocks.createCollection.mockResolvedValue({ id: "c_new" });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useSessionStore.setState({ lastCollectionId: "c2" });
	useToastStore.setState({ toasts: [] });
});

describe("DesignRunView - Save to request on an agent's unsaved run", () => {
	it("leads the header with Save, as the primary action", () => {
		renderView(designRun());

		const [save] = saveButtons();
		expect(saveButtons()).toHaveLength(1);
		expect(save.className).toContain("bg-primary-fill");
		const pin = screen.getByRole("button", { name: /^pin$/i });
		// Save comes before Pin in the header's order.
		expect(save.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it.each<[string, Partial<Run>]>([
		["an app run", { origin: { kind: "app" } }],
		["another client's run", { origin: { kind: "other" } }],
		["a run from an engine with no origin", { origin: undefined }],
	])("offers nothing on %s with no request", (_label, overrides) => {
		renderView(designRun(overrides));

		expect(saveButtons()).toHaveLength(0);
	});

	it("keeps the overwrite button, unpromoted, on a linked agent run", () => {
		mocks.liveRequest = {
			id: "req_1",
			collectionId: "c1",
			name: "Create user",
			method: "POST",
			url: "https://api.example.test/users",
			params: [],
			headers: [],
			body: { mode: "none" },
			auth: { mode: "none" },
			followRedirects: true,
			maxRedirects: 10,
			httpVersion: "auto",
			verifySSL: true,
			disableCookies: false,
			disabledSystemHeaders: [],
			disableUrlEncoding: false,
			elements: [],
		} as unknown as Request;
		renderView(designRun({ requestId: "req_1" }));

		const [save] = saveButtons();
		expect(saveButtons()).toHaveLength(1);
		expect(save.className).not.toContain("bg-primary-fill");
		const pin = screen.getByRole("button", { name: /^pin$/i });
		expect(pin.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		// It opens the confirm-and-overwrite dialog, not the create flow.
		fireEvent.click(save);
		expect(screen.getByText(/replaces the request's current values/i)).toBeTruthy();
		expect(mocks.createRequest).not.toHaveBeenCalled();
	});

	it("creates the request in the remembered collection, with the stamped description", async () => {
		renderView(designRun());

		fireEvent.click(saveButtons()[0]);

		await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledTimes(1));
		const sent = mocks.createRequest.mock.calls[0][0];
		expect(sent).toMatchObject({
			collectionId: "c2",
			name: "POST https://api.example.test/users",
			method: "POST",
			url: "https://api.example.test/users?page=2",
			body: { mode: "json", content: '{"a":1}' },
			headers: [expect.objectContaining({ key: "X-Plain", value: "visible" })],
		});
		// The product name, not the `claude-ai` the client sent.
		expect(sent.description).toMatch(/^Saved from a run started by Claude Desktop on \S+/);
		expect(sent.description).not.toContain("claude-ai");
		expect(sent).not.toHaveProperty("auth");
	});

	it("opens the new request in its own tab", async () => {
		renderView(designRun());

		fireEvent.click(saveButtons()[0]);

		await waitFor(() =>
			expect(useTabsStore.getState().openTabs).toEqual([
				expect.objectContaining({ type: "request", entityId: "req_new" }),
			])
		);
	});

	it("asks which collection when none is remembered, and files it there", async () => {
		useSessionStore.setState({ lastCollectionId: null });
		renderView(designRun());

		fireEvent.click(saveButtons()[0]);

		const picker = await screen.findByRole("dialog");
		expect(within(picker).getByText("Add request to")).toBeTruthy();
		expect(mocks.createRequest).not.toHaveBeenCalled();

		fireEvent.click(within(picker).getByRole("button", { name: /alpha/i }));

		await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledTimes(1));
		expect(mocks.createRequest.mock.calls[0][0]).toMatchObject({
			collectionId: "c1",
			description: expect.stringContaining("Claude Desktop"),
		});
	});

	it("creates a collection to hold it when the workspace has none", async () => {
		mocks.collections = [];
		useSessionStore.setState({ lastCollectionId: null });
		renderView(designRun());

		fireEvent.click(saveButtons()[0]);

		await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledTimes(1));
		expect(mocks.createRequest.mock.calls[0][0]).toMatchObject({ collectionId: "c_new" });
	});

	it("says so when the request cannot be created, and opens nothing", async () => {
		mocks.createRequest.mockRejectedValue(new Error("engine down"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		renderView(designRun());

		fireEvent.click(saveButtons()[0]);

		await waitFor(() =>
			expect(useToastStore.getState().toasts).toEqual([
				expect.objectContaining({
					variant: "error",
					message: expect.stringMatching(/couldn't create the request/i),
				}),
			])
		);
		expect(useTabsStore.getState().openTabs).toEqual([]);
	});

	it("names an agent that sent no name as an MCP client", async () => {
		const origin: RunOrigin = { kind: "mcp", client: null };
		renderView(designRun({ origin }));

		fireEvent.click(saveButtons()[0]);

		await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledTimes(1));
		expect(mocks.createRequest.mock.calls[0][0].description).toMatch(
			/^Saved from a run started by an MCP client on /
		);
	});
});
