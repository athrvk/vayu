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
 * The Import dialog's MCP server tab (#3843): a form that asks `POST /import/mcp` for the tree and
 * hands it to the preview and the apply every other tab uses, and `POST /import/mcp/diff` (#3842)
 * for the collections an earlier import of the server built. The engine's answers are stubbed here;
 * what it builds from a server and what it compares are pinned engine-side.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImportMcpApplyRequest, ImportMcpDiffMatch, ImportMcpRequest } from "@/types";
import type { ImportResult } from "@/services/importers/types";

const applied = vi.hoisted(() => ({ mutate: vi.fn() }));

/** Answers like the real mutation: each root's temp id mapped to a real id. */
vi.mock("@/queries/import", () => ({
	useImportMutation: () => ({
		mutateAsync: applied.mutate,
		isPending: false,
	}),
}));

import { ImportModal } from "./ImportModal";
import { useImportModalStore, useToastStore } from "@/stores";
import { queryKeys } from "@/queries/keys";
import { apiService } from "@/services/api";
import { ApiError } from "@/services/http-client";
import { collection, request, result } from "./import-preview.testkit";

const SERVER = "https://mcp.example.com/mcp";

/** What the engine builds for a server with one tool, as `POST /import/mcp` answers. */
function serverTree(opts: { withToken?: boolean } = {}): ImportResult {
	return result({
		collections: [
			collection({
				name: "Acme tools",
				variables: opts.withToken
					? { mcpToken: { value: "", enabled: true, secret: true } }
					: {},
				children: [
					collection({
						name: "Tools",
						requests: [request({ name: "search_docs", method: "POST", url: SERVER })],
					}),
				],
			}),
		],
		meta: { format: "MCP server", requestCount: 1, folderCount: 1 },
	});
}

/**
 * An earlier import of the server whose `search` tool the diff guesses is now listed as `find`:
 * both halves stay in `added` and `removed`, and the guess is its own entry.
 */
function renamedToolMatch(over: Partial<ImportMcpDiffMatch> = {}): ImportMcpDiffMatch {
	return {
		collectionId: "col_1",
		name: "Acme tools",
		identical: false,
		added: [
			{ kind: "tool", key: "export", name: "export" },
			{ kind: "tool", key: "find", name: "find" },
		],
		removed: [
			{ kind: "tool", key: "search", name: "search", requestId: "req_5" },
			{ kind: "resource", key: "file:///a.txt", name: "a.txt", requestId: "req_9" },
		],
		changed: [
			{
				kind: "tool",
				key: "lookup",
				name: "lookup",
				requestId: "req_1",
				fields: ["description"],
			},
			{
				kind: "prompt",
				key: "greet",
				name: "greet",
				requestId: "req_2",
				fields: ["description", "inputSchema"],
			},
		],
		renameCandidates: [
			{
				kind: "tool",
				key: "find",
				name: "search",
				requestId: "req_5",
				fields: [],
				renamedFrom: "search",
			},
		],
		...over,
	};
}

function renderModal(client = new QueryClient()) {
	return render(
		<QueryClientProvider client={client}>
			<ImportModal />
		</QueryClientProvider>
	);
}

/** Radix tabs activate on mousedown, not a bare click (see ImportModal.curl.test.tsx). */
function selectTab(name: RegExp) {
	const tab = screen.getByRole("tab", { name });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
}

function urlInput(): HTMLInputElement {
	return screen.getByLabelText("Server URL") as HTMLInputElement;
}

function tokenInput(): HTMLInputElement {
	return screen.getByLabelText(/Bearer token/) as HTMLInputElement;
}

function connectButton(): HTMLButtonElement {
	return screen.getByRole("button", { name: /^Connect$/ }) as HTMLButtonElement;
}

function openMcpTab(client?: QueryClient) {
	renderModal(client);
	selectTab(/^MCP server$/);
}

function typeUrl(value = SERVER) {
	fireEvent.change(urlInput(), { target: { value } });
}

/** The answer a test releases by hand, so a case can act while the call is in flight. */
function deferredAnswer() {
	let resolve!: (value: ImportResult) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<ImportResult>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function lastPayload(spy: ReturnType<typeof vi.spyOn>): ImportMcpRequest {
	return spy.mock.calls.at(-1)?.[0] as ImportMcpRequest;
}

describe("ImportModal MCP server tab", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		applied.mutate.mockReset();
		applied.mutate.mockImplementation(async () => ({
			idMap: { c1: "col_1" },
			rootIds: { c1: "col_1" },
			environmentIds: {},
		}));
		// Every connect also asks for the earlier imports of the server; none by default.
		vi.spyOn(apiService, "importMcpDiff").mockResolvedValue({ matches: [] });
		useToastStore.setState({ toasts: [] });
		useImportModalStore.setState({ isOpen: true });
	});

	it("draws no divider with border-border, the token invisible on the dialog's card", () => {
		openMcpTab();
		const invisible = [
			screen.getByRole("dialog"),
			...screen.getByRole("dialog").querySelectorAll("*"),
		]
			.filter((el) => (el.getAttribute("class") ?? "").split(/\s+/).includes("border-border"))
			.filter((el) => !(el.getAttribute("class") ?? "").split(/\s+/).includes("bg-panel"));
		expect(invisible).toEqual([]);
		expect(screen.getByLabelText("Server URL")).toBeInTheDocument();
	});

	it("is the fourth tab, in sentence case", () => {
		renderModal();
		// The accessible name: a trigger also holds a hidden copy of its label to reserve width.
		const tabs = screen.getAllByRole("tab");
		["File", "URL", "Paste", "MCP server"].forEach((name, i) =>
			expect(tabs[i]).toHaveAccessibleName(name)
		);
		expect(tabs).toHaveLength(4);
	});

	describe("the request it sends", () => {
		it("posts the URL, the headers, the token and the primitives asked for", async () => {
			const importMcp = vi.spyOn(apiService, "importMcp").mockResolvedValue(serverTree());
			openMcpTab();
			typeUrl(`  ${SERVER}  `);
			fireEvent.change(screen.getByPlaceholderText("Name"), {
				target: { value: "X-Tenant" },
			});
			fireEvent.change(screen.getAllByPlaceholderText("Value")[0], {
				target: { value: "acme" },
			});
			fireEvent.change(tokenInput(), { target: { value: "s3cret" } });
			fireEvent.click(screen.getByRole("checkbox", { name: "Resources" }));
			fireEvent.click(connectButton());

			await waitFor(() => expect(importMcp).toHaveBeenCalledTimes(1));
			expect(lastPayload(importMcp)).toEqual({
				url: SERVER,
				headers: [{ name: "X-Tenant", value: "acme" }],
				auth: { mode: "bearer", token: "s3cret" },
				include: { tools: true, resources: true, prompts: false },
			});
			expect(importMcp.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
		});

		it("leaves headers and auth out when none were entered", async () => {
			const importMcp = vi.spyOn(apiService, "importMcp").mockResolvedValue(serverTree());
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());

			await waitFor(() => expect(importMcp).toHaveBeenCalledTimes(1));
			expect(lastPayload(importMcp)).toEqual({
				url: SERVER,
				include: { tools: true, resources: false, prompts: false },
			});
		});

		it("sends Enter in the URL box as Connect, and Ctrl+Enter as nothing", async () => {
			const importMcp = vi.spyOn(apiService, "importMcp").mockResolvedValue(serverTree());
			openMcpTab();
			typeUrl();

			fireEvent.keyDown(urlInput(), { key: "Enter", ctrlKey: true });
			expect(importMcp).not.toHaveBeenCalled();

			fireEvent.keyDown(urlInput(), { key: "Enter" });
			await waitFor(() => expect(importMcp).toHaveBeenCalledTimes(1));
		});
	});

	describe("Connect is offered only when it can be answered", () => {
		it("is off for a blank URL and on once one is typed", () => {
			openMcpTab();
			expect(connectButton().disabled).toBe(true);
			typeUrl("   ");
			expect(connectButton().disabled).toBe(true);
			typeUrl();
			expect(connectButton().disabled).toBe(false);
		});

		it("is off when nothing is included, which the engine would refuse", () => {
			const importMcp = vi.spyOn(apiService, "importMcp");
			openMcpTab();
			typeUrl();
			fireEvent.click(screen.getByRole("checkbox", { name: "Tools" }));
			expect(connectButton().disabled).toBe(true);

			fireEvent.keyDown(urlInput(), { key: "Enter" });
			expect(importMcp).not.toHaveBeenCalled();

			fireEvent.click(screen.getByRole("checkbox", { name: "Prompts" }));
			expect(connectButton().disabled).toBe(false);
		});
	});

	describe("the preview and the apply are the other tabs' own", () => {
		it("lists what the server offers and applies the tree it was shown", async () => {
			const tree = serverTree();
			vi.spyOn(apiService, "importMcp").mockResolvedValue(tree);
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());

			expect(await screen.findByText("search_docs")).toBeInTheDocument();
			expect(screen.getByText("Acme tools")).toBeInTheDocument();

			fireEvent.click(screen.getByRole("button", { name: /^Import →$/ }));

			await waitFor(() => expect(applied.mutate).toHaveBeenCalledTimes(1));
			expect(applied.mutate.mock.calls[0][0].result).toBe(tree);
			await waitFor(() => expect(useImportModalStore.getState().isOpen).toBe(false));
		});

		it("does not offer the environment and script options, which an MCP tree cannot use", async () => {
			vi.spyOn(apiService, "importMcp").mockResolvedValue(serverTree());
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());
			await screen.findByText("search_docs");

			expect(screen.queryByText(/Import environments/)).toBeNull();
			expect(screen.queryByText(/Import pre-request/)).toBeNull();
			// The footer's actions stay, and Import is not pushed off its edge by the gap.
			expect(screen.getByRole("button", { name: /^Import →$/ })).toBeInTheDocument();
		});

		it("shows the server's URL under the format name", async () => {
			vi.spyOn(apiService, "importMcp").mockResolvedValue(serverTree());
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());

			await screen.findByText("search_docs");
			expect(screen.getByText(SERVER)).toBeInTheDocument();
		});

		it("says the token is not stored when the server was reached with one", async () => {
			vi.spyOn(apiService, "importMcp").mockResolvedValue(serverTree({ withToken: true }));
			openMcpTab();
			typeUrl();
			fireEvent.change(tokenInput(), { target: { value: "s3cret" } });
			fireEvent.click(connectButton());

			expect(
				await screen.findByText(/The token is not stored in the collection.*mcpToken/)
			).toBeInTheDocument();
			expect(screen.queryByText(/s3cret/)).toBeNull();
		});

		it("says nothing about a token when none was given", async () => {
			vi.spyOn(apiService, "importMcp").mockResolvedValue(serverTree());
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());
			await screen.findByText("search_docs");

			expect(screen.queryByText(/not stored in the collection/)).toBeNull();
		});
	});

	describe("an earlier import of the same server (#3842)", () => {
		async function connectWith(matches: ImportMcpDiffMatch[]) {
			vi.spyOn(apiService, "importMcp").mockResolvedValue(serverTree());
			vi.spyOn(apiService, "importMcpDiff").mockResolvedValue({ matches });
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());
			await screen.findByText("search_docs");
		}

		const report = () => screen.queryByRole("region", { name: /Earlier import/ });

		it("asks the diff route with the request the connect sent, and the same cancel", async () => {
			const importMcp = vi.spyOn(apiService, "importMcp").mockResolvedValue(serverTree());
			const diff = vi.spyOn(apiService, "importMcpDiff").mockResolvedValue({ matches: [] });
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());
			await screen.findByText("search_docs");

			expect(diff).toHaveBeenCalledTimes(1);
			expect(diff.mock.calls[0][0]).toEqual(lastPayload(importMcp));
			expect(diff.mock.calls[0][1]?.signal).toBe(importMcp.mock.calls[0][1]?.signal);
		});

		it("shows a possible rename beside the two rows it pairs, which stay added and removed", async () => {
			await connectWith([renamedToolMatch()]);

			const found = within(report() as HTMLElement);
			expect(found.getByText("2 added · 2 changed · 2 removed")).toBeInTheDocument();
			expect(found.getByText("Possible rename")).toBeInTheDocument();
			expect(found.getByText("search → find")).toBeInTheDocument();
			expect(found.getByText("prompt - description, input schema")).toBeInTheDocument();
			expect(found.getByText("export")).toBeInTheDocument();
			expect(found.getByText("a.txt")).toBeInTheDocument();
			// The guess consumes nothing: the new tool is an add and the old one a removal.
			expect(found.getByText("find")).toBeInTheDocument();
			expect(found.getByText("search")).toBeInTheDocument();
		});

		it("states every count, the zeros included, for a server that has not moved", async () => {
			await connectWith([
				renamedToolMatch({
					identical: true,
					added: [],
					removed: [],
					changed: [],
					renameCandidates: [],
				}),
			]);

			const found = within(report() as HTMLElement);
			expect(found.getByText("0 added · 0 changed · 0 removed")).toBeInTheDocument();
			expect(found.getByText(/Nothing differs/)).toBeInTheDocument();
			expect(found.queryByText("Added")).toBeNull();
			expect(found.queryByText("Changed")).toBeNull();
			expect(found.queryByText("Removed")).toBeNull();
		});

		it("reports each collection an earlier import made", async () => {
			await connectWith([
				renamedToolMatch(),
				renamedToolMatch({
					collectionId: "col_2",
					name: "Acme tools copy",
					added: [],
					removed: [],
					changed: [],
					renameCandidates: [],
					identical: true,
				}),
			]);

			const found = within(report() as HTMLElement);
			expect(found.getByText("Acme tools")).toBeInTheDocument();
			expect(found.getByText("Acme tools copy")).toBeInTheDocument();
			expect(found.getByText(/leaves the existing ones as they are/)).toBeInTheDocument();
		});

		it("says Import anyway makes a new collection, and imports the shown tree as one", async () => {
			const tree = serverTree();
			vi.spyOn(apiService, "importMcp").mockResolvedValue(tree);
			vi.spyOn(apiService, "importMcpDiff").mockResolvedValue({
				matches: [renamedToolMatch()],
			});
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());
			await screen.findByText("search_docs");

			expect(
				screen.getByText(
					/Import anyway creates a new collection and leaves the existing one as it is/
				)
			).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: /^Import →$/ })).toBeNull();
			fireEvent.click(screen.getByRole("button", { name: /^Import anyway →$/ }));

			await waitFor(() => expect(applied.mutate).toHaveBeenCalledTimes(1));
			expect(applied.mutate.mock.calls[0][0].result).toBe(tree);
		});

		it("shows nothing extra when no collection holds the server's URL", async () => {
			await connectWith([]);

			expect(report()).toBeNull();
			expect(screen.getByRole("button", { name: /^Import →$/ })).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: /Import anyway/ })).toBeNull();
		});

		it("still previews and imports when the comparison fails, without a word of it", async () => {
			vi.spyOn(apiService, "importMcp").mockResolvedValue(serverTree());
			vi.spyOn(apiService, "importMcpDiff").mockRejectedValue(
				new ApiError(502, "BAD_GATEWAY", "The server did not answer")
			);
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());
			await screen.findByText("search_docs");

			expect(report()).toBeNull();
			expect(screen.queryByText(/did not answer/)).toBeNull();
			expect(useToastStore.getState().toasts).toEqual([]);
			fireEvent.click(screen.getByRole("button", { name: /^Import →$/ }));
			await waitFor(() => expect(applied.mutate).toHaveBeenCalledTimes(1));
		});

		it("does not ask for a comparison when the connect itself failed", async () => {
			vi.spyOn(apiService, "importMcp").mockRejectedValue(
				new ApiError(502, "BAD_GATEWAY", "The server did not answer")
			);
			const diff = vi.spyOn(apiService, "importMcpDiff");
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());

			expect(await screen.findByText(/did not answer/)).toBeInTheDocument();
			expect(diff).not.toHaveBeenCalled();
		});
	});

	describe("a failure", () => {
		it("shows the engine's message and keeps what was typed", async () => {
			vi.spyOn(apiService, "importMcp").mockRejectedValue(
				new ApiError(
					400,
					"BAD_REQUEST",
					"Invalid 'url': put credentials in auth or headers, not the URL"
				)
			);
			openMcpTab();
			typeUrl("https://user:pw@mcp.example.com/mcp");
			fireEvent.click(connectButton());

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Invalid 'url': put credentials in auth or headers, not the URL"
			);
			expect(urlInput().value).toBe("https://user:pw@mcp.example.com/mcp");
			expect(connectButton().disabled).toBe(false);
		});
	});

	describe("a connect in flight belongs to its tab", () => {
		it("keeps running while another tab is shown, and lands on its own", async () => {
			const answer = deferredAnswer();
			const importMcp = vi.spyOn(apiService, "importMcp").mockReturnValue(answer.promise);
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());
			await waitFor(() => expect(importMcp).toHaveBeenCalledTimes(1));
			const signal = importMcp.mock.calls[0][1]?.signal as AbortSignal;

			selectTab(/^File$/);
			expect(signal.aborted).toBe(false);
			expect(screen.queryByText("search_docs")).toBeNull();

			answer.resolve(serverTree());
			selectTab(/^MCP server$/);
			expect(await screen.findByText("search_docs")).toBeInTheDocument();
		});

		it("cancels on close and drops a reply that arrives after it", async () => {
			const answer = deferredAnswer();
			const importMcp = vi.spyOn(apiService, "importMcp").mockReturnValue(answer.promise);
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());
			await waitFor(() => expect(importMcp).toHaveBeenCalledTimes(1));
			const signal = importMcp.mock.calls[0][1]?.signal as AbortSignal;

			fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
			await waitFor(() => expect(useImportModalStore.getState().isOpen).toBe(false));
			expect(signal.aborted).toBe(true);

			answer.resolve(serverTree());
			useImportModalStore.setState({ isOpen: true });

			// The reopened dialog is empty: the late reply was not written into it.
			await screen.findByLabelText("Server URL");
			expect(urlInput().value).toBe("");
			expect(screen.queryByText("search_docs")).toBeNull();
			expect(screen.queryByRole("button", { name: /^Import →$/ })).toBeNull();
		});
	});

	describe("the token stays in the form", () => {
		it("is gone after the preview is dismissed", async () => {
			vi.spyOn(apiService, "importMcp").mockResolvedValue(serverTree({ withToken: true }));
			openMcpTab();
			typeUrl();
			fireEvent.change(tokenInput(), { target: { value: "s3cret" } });
			fireEvent.click(connectButton());
			await screen.findByText("search_docs");

			fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

			await screen.findByLabelText("Server URL");
			expect(tokenInput().value).toBe("");
			expect(urlInput().value).toBe("");
		});

		it("is gone after the dialog is closed and reopened", async () => {
			openMcpTab();
			typeUrl();
			fireEvent.change(tokenInput(), { target: { value: "s3cret" } });

			fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
			await waitFor(() => expect(useImportModalStore.getState().isOpen).toBe(false));
			useImportModalStore.setState({ isOpen: true });

			await screen.findByLabelText(/Bearer token/);
			expect(tokenInput().value).toBe("");
		});

		it("survives a switch to another tab and back", () => {
			openMcpTab();
			fireEvent.change(tokenInput(), { target: { value: "s3cret" } });

			selectTab(/^URL$/);
			selectTab(/^MCP server$/);

			expect(tokenInput().value).toBe("s3cret");
		});
	});

	describe("Update existing (#3994)", () => {
		const APPLIED = {
			collectionId: "col_1",
			created: [{ kind: "tool" as const, key: "export", requestId: "req_3" }],
			updated: ["req_1", "req_2"],
			deleted: [] as string[],
		};
		const secondMatch = (): ImportMcpDiffMatch =>
			renamedToolMatch({
				collectionId: "col_2",
				name: "Acme tools copy",
				added: [{ kind: "prompt", key: "hello", name: "hello" }],
				changed: [],
				removed: [],
				renameCandidates: [],
			});

		let importMcpApply: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			importMcpApply = vi.spyOn(apiService, "importMcpApply").mockResolvedValue(APPLIED);
		});

		/** Connect with `token` typed, to the diff `matches` answers. */
		async function connectTo(
			matches: ImportMcpDiffMatch[],
			opts: { client?: QueryClient; token?: string } = {}
		) {
			const importMcp = vi.spyOn(apiService, "importMcp").mockResolvedValue(serverTree());
			vi.spyOn(apiService, "importMcpDiff").mockResolvedValue({ matches });
			openMcpTab(opts.client);
			typeUrl();
			if (opts.token) fireEvent.change(tokenInput(), { target: { value: opts.token } });
			fireEvent.click(connectButton());
			await screen.findByText("search_docs");
			return importMcp;
		}

		const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
		const updateButton = () => screen.getByRole("button", { name: /^Update existing$/ });
		const sent = () => importMcpApply.mock.calls.at(-1)?.[0] as ImportMcpApplyRequest;

		it("offers it beside Import anyway for the one collection, and not Import", async () => {
			await connectTo([renamedToolMatch()]);

			expect(updateButton()).toBeEnabled();
			expect(screen.getByRole("button", { name: /^Import anyway →$/ })).toBeEnabled();
			expect(screen.queryByRole("button", { name: /^Import →$/ })).toBeNull();
		});

		it("offers nothing when no earlier import holds the server's URL", async () => {
			await connectTo([]);

			expect(screen.queryByRole("button", { name: /Update existing/ })).toBeNull();
		});

		it("starts with added and changed rows ticked, and the removed one and the possible rename not", async () => {
			await connectTo([renamedToolMatch()]);

			expect(box("export (tool)").checked).toBe(true);
			expect(box("find (tool)").checked).toBe(true);
			expect(box("lookup (tool)").checked).toBe(true);
			expect(box("greet (prompt)").checked).toBe(true);
			expect(box("a.txt (resource)").checked).toBe(false);
			expect(box("search (tool)").checked).toBe(false);
			expect(box("search → find (tool)").checked).toBe(false);
		});

		it("sends the connect's request, the collection and the ticks, then closes and says what landed", async () => {
			const client = new QueryClient();
			const invalidate = vi.spyOn(client, "invalidateQueries");
			const importMcp = await connectTo([renamedToolMatch()], { client, token: "s3cret" });
			fireEvent.click(box("greet (prompt)"));

			fireEvent.click(updateButton());

			await waitFor(() => expect(importMcpApply).toHaveBeenCalledTimes(1));
			expect(sent()).toEqual({
				...lastPayload(importMcp),
				collectionId: "col_1",
				select: {
					added: [
						{ kind: "tool", key: "export" },
						{ kind: "tool", key: "find" },
					],
					changed: ["req_1"],
					removed: [],
					renamed: [],
				},
			});
			expect(sent().auth).toEqual({ mode: "bearer", token: "s3cret" });
			await waitFor(() => expect(useImportModalStore.getState().isOpen).toBe(false));
			expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
				'Updated "Acme tools" - 1 request created, 2 updated, 0 deleted.',
			]);
			// No second collection: the tree is refreshed, not written to.
			expect(applied.mutate).not.toHaveBeenCalled();
			const refreshed = invalidate.mock.calls.map((call) => call[0]?.queryKey);
			expect(refreshed).toContainEqual(queryKeys.collections.all);
			expect(refreshed).toContainEqual(queryKeys.requests.all);
		});

		it("sends a ticked possible rename as a rename, not also as the add and the removal it pairs", async () => {
			await connectTo([renamedToolMatch()]);
			// The removal is ticked first: once the rename is, it stands in for that row, so no
			// request is deleted and the delete confirmation is not asked.
			fireEvent.click(box("search (tool)"));
			fireEvent.click(box("search → find (tool)"));

			expect(box("find (tool)").checked).toBe(false);
			expect(box("search (tool)").checked).toBe(false);
			fireEvent.click(updateButton());

			await waitFor(() => expect(importMcpApply).toHaveBeenCalledTimes(1));
			expect(screen.queryByText(/Delete requests the server/)).toBeNull();
			expect(sent().select).toEqual({
				added: [{ kind: "tool", key: "export" }],
				changed: ["req_1", "req_2"],
				removed: [],
				renamed: [{ requestId: "req_5", key: "find" }],
			});
		});

		it("is off while nothing is ticked", async () => {
			await connectTo([renamedToolMatch()]);

			["export (tool)", "find (tool)", "lookup (tool)", "greet (prompt)"].forEach((name) =>
				fireEvent.click(box(name))
			);

			expect(updateButton()).toBeDisabled();
			fireEvent.click(box("a.txt (resource)"));
			expect(updateButton()).toBeEnabled();
		});

		it("asks before deleting, naming the count, and deletes only what was ticked", async () => {
			await connectTo([renamedToolMatch()]);
			fireEvent.click(box("a.txt (resource)"));

			fireEvent.click(updateButton());

			const confirm = await screen.findByRole("dialog", {
				name: "Delete requests the server no longer lists?",
			});
			expect(
				within(confirm).getByText(/1 request and everything saved on it are deleted/)
			).toBeInTheDocument();
			expect(importMcpApply).not.toHaveBeenCalled();

			// Backing out writes nothing and keeps the tick.
			fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
			await waitFor(() =>
				expect(screen.queryByText(/Delete requests the server/)).toBeNull()
			);
			expect(importMcpApply).not.toHaveBeenCalled();
			expect(box("a.txt (resource)").checked).toBe(true);

			fireEvent.click(updateButton());
			fireEvent.click(
				within(await screen.findByRole("dialog", { name: /Delete requests/ })).getByRole(
					"button",
					{ name: "Update and delete" }
				)
			);

			await waitFor(() => expect(importMcpApply).toHaveBeenCalledTimes(1));
			expect(sent().select).toEqual({
				added: [
					{ kind: "tool", key: "export" },
					{ kind: "tool", key: "find" },
				],
				changed: ["req_1", "req_2"],
				removed: ["req_9"],
				renamed: [],
			});
		});

		it("does not ask when nothing is to be deleted", async () => {
			await connectTo([renamedToolMatch()]);

			fireEvent.click(updateButton());

			await waitFor(() => expect(importMcpApply).toHaveBeenCalledTimes(1));
			expect(screen.queryByText(/Delete requests the server/)).toBeNull();
		});

		it("says to compare again on a 409, keeps the selection, and stays open", async () => {
			importMcpApply.mockRejectedValue(
				new ApiError(
					409,
					"CONFLICT",
					"export is no longer an added entry in this server's diff of the collection"
				)
			);
			await connectTo([renamedToolMatch()]);
			fireEvent.click(box("export (tool)"));
			fireEvent.click(box("a.txt (resource)"));

			fireEvent.click(updateButton());
			fireEvent.click(
				within(await screen.findByRole("dialog", { name: /Delete requests/ })).getByRole(
					"button",
					{ name: "Update and delete" }
				)
			);

			const failure = await screen.findByText(
				/Couldn't update the collection - export is no longer/
			);
			expect(failure).toHaveTextContent("Nothing was written");
			expect(failure).toHaveTextContent("connect again to compare");
			// Still the diff, still as ticked: nothing was written, so there is nothing to redo.
			await waitFor(() =>
				expect(screen.queryByText(/Delete requests the server/)).toBeNull()
			);
			expect(useImportModalStore.getState().isOpen).toBe(true);
			expect(box("export (tool)").checked).toBe(false);
			expect(box("a.txt (resource)").checked).toBe(true);
			expect(box("greet (prompt)").checked).toBe(true);
			expect(useToastStore.getState().toasts).toEqual([]);
			expect(updateButton()).toBeEnabled();
		});

		it("writes nothing to the tree after a failure", async () => {
			importMcpApply.mockRejectedValue(
				new ApiError(502, "BAD_GATEWAY", "The server did not answer")
			);
			const client = new QueryClient();
			const invalidate = vi.spyOn(client, "invalidateQueries");
			await connectTo([renamedToolMatch()], { client });

			fireEvent.click(updateButton());

			expect(await screen.findByText(/did not answer/)).toBeInTheDocument();
			expect(invalidate).not.toHaveBeenCalled();
		});

		it("holds the dialog and both buttons while the update is under way", async () => {
			let release!: (value: typeof APPLIED) => void;
			importMcpApply.mockReturnValue(new Promise((res) => (release = res)));
			await connectTo([renamedToolMatch()]);

			fireEvent.click(updateButton());

			const busy = await screen.findByRole("button", { name: /^Updating…$/ });
			expect(busy).toBeDisabled();
			expect(screen.getByRole("button", { name: /^Import anyway →$/ })).toBeDisabled();
			expect(box("export (tool)").disabled).toBe(true);
			release(APPLIED);
			await waitFor(() => expect(useImportModalStore.getState().isOpen).toBe(false));
		});

		it("starts the next connect from the defaults and with that connect's request", async () => {
			importMcpApply.mockRejectedValue(new ApiError(409, "CONFLICT", "stale"));
			await connectTo([renamedToolMatch()], { token: "first-token" });
			fireEvent.click(box("a.txt (resource)"));
			fireEvent.click(updateButton());
			fireEvent.click(
				within(await screen.findByRole("dialog", { name: /Delete requests/ })).getByRole(
					"button",
					{ name: "Update and delete" }
				)
			);
			await screen.findByText(/Couldn't update the collection/);

			// Dismissing drops the form and the entry, token and request with them.
			fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
			await screen.findByLabelText("Server URL");
			expect(tokenInput().value).toBe("");
			typeUrl();
			fireEvent.change(tokenInput(), { target: { value: "second-token" } });
			fireEvent.click(connectButton());
			await screen.findByText("search_docs");

			expect(screen.queryByText(/Couldn't update the collection/)).toBeNull();
			expect(box("a.txt (resource)").checked).toBe(false);
			importMcpApply.mockResolvedValue(APPLIED);
			fireEvent.click(updateButton());
			await waitFor(() => expect(importMcpApply).toHaveBeenCalledTimes(2));
			expect(sent().auth).toEqual({ mode: "bearer", token: "second-token" });
			expect(sent().select.removed).toEqual([]);
		});

		describe("with several earlier imports", () => {
			it("gives each its own Update existing, and the footer has none", async () => {
				await connectTo([renamedToolMatch(), secondMatch()]);

				const buttons = screen.getAllByRole("button", { name: /^Update existing$/ });
				expect(buttons).toHaveLength(2);
				// Each sits inside its match's report, not in the footer beside Import anyway.
				expect(
					buttons.map((b) => b.closest('[role="group"]')?.getAttribute("aria-label"))
				).toEqual(["Acme tools", "Acme tools copy"]);
			});

			it("updates the one it sits under, with that match's ticks alone", async () => {
				await connectTo([renamedToolMatch(), secondMatch()]);

				const second = within(screen.getByRole("group", { name: "Acme tools copy" }));
				fireEvent.click(second.getByRole("button", { name: /^Update existing$/ }));

				await waitFor(() => expect(importMcpApply).toHaveBeenCalledTimes(1));
				expect(sent().collectionId).toBe("col_2");
				expect(sent().select).toEqual({
					added: [{ kind: "prompt", key: "hello" }],
					changed: [],
					removed: [],
					renamed: [],
				});
			});
		});
	});
});
