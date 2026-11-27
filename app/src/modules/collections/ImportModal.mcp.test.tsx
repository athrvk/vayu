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
import type { ImportMcpDiffMatch, ImportMcpRequest } from "@/types";
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

/** An earlier import of the server whose `search` tool is now listed as `find`. */
function renamedToolMatch(over: Partial<ImportMcpDiffMatch> = {}): ImportMcpDiffMatch {
	return {
		collectionId: "col_1",
		name: "Acme tools",
		identical: false,
		added: [{ kind: "tool", key: "export", name: "export" }],
		removed: [{ kind: "resource", key: "file:///a.txt", name: "a.txt", requestId: "req_9" }],
		changed: [
			{
				kind: "tool",
				key: "find",
				name: "search",
				requestId: "req_1",
				fields: [],
				renamedFrom: "search",
			},
			{
				kind: "prompt",
				key: "greet",
				name: "greet",
				requestId: "req_2",
				fields: ["description", "inputSchema"],
			},
		],
		...over,
	};
}

function renderModal() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
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

function openMcpTab() {
	renderModal();
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

		it("shows a renamed tool as one change, beside what was added and removed", async () => {
			await connectWith([renamedToolMatch()]);

			const found = within(report() as HTMLElement);
			expect(found.getByText("1 added · 2 changed · 1 removed")).toBeInTheDocument();
			expect(found.getByText("search → find")).toBeInTheDocument();
			expect(found.getByText("tool - renamed")).toBeInTheDocument();
			expect(found.getByText("prompt - description, input schema")).toBeInTheDocument();
			expect(found.getByText("export")).toBeInTheDocument();
			expect(found.getByText("a.txt")).toBeInTheDocument();
			// One line for the rename: the old name is not also a removal and the new one an add.
			expect(found.getAllByText(/search/)).toHaveLength(1);
			expect(found.getAllByText(/find/)).toHaveLength(1);
		});

		it("states every count, the zeros included, for a server that has not moved", async () => {
			await connectWith([
				renamedToolMatch({ identical: true, added: [], removed: [], changed: [] }),
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
					identical: true,
				}),
			]);

			const found = within(report() as HTMLElement);
			expect(found.getByText("Acme tools")).toBeInTheDocument();
			expect(found.getByText("Acme tools copy")).toBeInTheDocument();
			expect(found.getByText(/existing ones/)).toBeInTheDocument();
		});

		it("says Import anyway, says nothing changes, and imports the shown tree as a new collection", async () => {
			const tree = serverTree();
			vi.spyOn(apiService, "importMcp").mockResolvedValue(tree);
			vi.spyOn(apiService, "importMcpDiff").mockResolvedValue({
				matches: [renamedToolMatch()],
			});
			openMcpTab();
			typeUrl();
			fireEvent.click(connectButton());
			await screen.findByText("search_docs");

			expect(screen.getByText(/nothing is changed in the existing one/)).toBeInTheDocument();
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
});
