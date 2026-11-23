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
 * An `mcp` body's tool has a reader on load and a writer on save (#3762).
 *
 * The engine stores `mcpTool` inside the body object, so a body written without
 * it clears it, and a request opened in `mcp` mode has to carry the tool in its
 * editor state or the first save of anything else would. Real builder, provider
 * and query client, with `GET` / `PUT /requests/:id` stubbed as
 * `RequestBuilder.body-mode-echo.test.tsx` does.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { useRequestQuery } from "@/queries";
import { queryKeys } from "@/queries/keys";
import { useClientSettingsStore, useTabsStore } from "@/stores";
import type { Request, RequestBody, UpdateRequestRequest } from "@/types";
import { useRequestBuilderContext } from "./context/RequestBuilderContext";

function Probe() {
	const { request, updateField, saveRequest } = useRequestBuilderContext();
	const { data: cached } = useRequestQuery("req_1");
	return (
		<>
			<span data-testid="bodyMode">{request.bodyMode}</span>
			<span data-testid="mcpTool">{JSON.stringify(request.mcpTool ?? null)}</span>
			<span data-testid="cached-at">{cached?.updatedAt}</span>
			<button onClick={() => updateField("mcpTool", { name: "edited" })}>edit tool</button>
			<button onClick={() => updateField("mcpTool", undefined)}>clear tool</button>
			<button onClick={() => updateField("bodyMode", "json")}>to json</button>
			<button onClick={() => updateField("bodyMode", "mcp")}>to mcp</button>
			<button onClick={() => void saveRequest()}>save</button>
		</>
	);
}

vi.mock("./components/RequestBuilderLayout", () => ({ default: () => <Probe /> }));

const { default: RequestBuilder } = await import("./index");

const SAVED_AT = "2026-01-02T00:00:00.000Z";
const CALL = '{"method":"tools/call","params":{"name":"execute_sql"}}';
const TOOL = {
	name: "execute_sql",
	inputSchema: { type: "object", properties: { region: { "x-mcp-header": "Region" } } },
};
const MCP_BODY: RequestBody = { mode: "mcp", content: CALL, mcpTool: TOOL };

const storedRequest = (body: RequestBody) =>
	({
		id: "req_1",
		collectionId: "col_1",
		name: "Run SQL",
		method: "POST",
		url: "https://mcp.test/rpc",
		params: [],
		headers: [],
		body,
		bodyType: body.mode,
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
	}) as unknown as Request;

let server: Request;
let updates: UpdateRequestRequest[];

beforeEach(() => {
	server = storedRequest(MCP_BODY);
	updates = [];
	vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
	vi.spyOn(apiService, "getRequest").mockImplementation(() => Promise.resolve({ ...server }));
	vi.spyOn(apiService, "updateRequest").mockImplementation((data: UpdateRequestRequest) => {
		updates.push(data);
		server = {
			...server,
			...(data.body && { body: data.body }),
			updatedAt: SAVED_AT,
		} as Request;
		return Promise.resolve({ ...server });
	});
	useClientSettingsStore.getState().setAutoSave({ enabled: false });
	act(() => {
		useTabsStore.setState({
			openTabs: [
				{ id: "t_req_1", type: "request", entityId: "req_1", title: "req_1" } as never,
			],
			activeTabId: "t_req_1",
		});
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function renderOpenRequest(): QueryClient {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<RequestBuilder />
		</QueryClientProvider>
	);
	return client;
}

const shown = (testId: string) => screen.getByTestId(testId).textContent;

async function saveAndAwaitEcho() {
	fireEvent.click(screen.getByText("save"));
	await waitFor(() => expect(shown("cached-at")).toBe(SAVED_AT));
}

describe("the stored mcp body in the editor", () => {
	it("opens in mcp mode with its tool", async () => {
		renderOpenRequest();

		await waitFor(() => expect(shown("bodyMode")).toBe("mcp"));
		expect(JSON.parse(shown("mcpTool") ?? "")).toEqual(TOOL);
	});

	it("saves an edited tool inside the body, beside the mode", async () => {
		renderOpenRequest();
		await waitFor(() => expect(shown("bodyMode")).toBe("mcp"));

		fireEvent.click(screen.getByText("edit tool"));
		await saveAndAwaitEcho();

		expect(updates).toHaveLength(1);
		expect(updates[0].body).toEqual({
			mode: "mcp",
			content: CALL,
			mcpTool: { name: "edited" },
		});
		expect(updates[0].bodyType).toBe("mcp");
	});

	it("saves a cleared tool as a body with no mcpTool, which is how the engine drops it", async () => {
		renderOpenRequest();
		await waitFor(() => expect(shown("mcpTool")).not.toBe("null"));

		fireEvent.click(screen.getByText("clear tool"));
		await saveAndAwaitEcho();

		expect(updates[0].body).toEqual({ mode: "mcp", content: CALL });
		expect(updates[0].body).not.toHaveProperty("mcpTool");
	});

	it("keeps the tool through a save made in another mode", async () => {
		renderOpenRequest();
		await waitFor(() => expect(shown("bodyMode")).toBe("mcp"));

		fireEvent.click(screen.getByText("to json"));
		await saveAndAwaitEcho();
		expect(server.body.mode).toBe("json");

		fireEvent.click(screen.getByText("to mcp"));

		expect(JSON.parse(shown("mcpTool") ?? "")).toEqual(TOOL);
	});

	it("adopts an outside write that removed the tool", async () => {
		const client = renderOpenRequest();
		await waitFor(() => expect(shown("mcpTool")).not.toBe("null"));

		act(() => {
			client.setQueryData(queryKeys.requests.detail("req_1"), {
				...server,
				body: { mode: "mcp", content: CALL },
				updatedAt: SAVED_AT,
			});
		});

		await waitFor(() => expect(shown("mcpTool")).toBe("null"));
	});
});
