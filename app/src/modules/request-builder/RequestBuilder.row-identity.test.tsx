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
 * A table row survives the save's own echo, and a refetch of an untouched
 * table is no conflict (#3663).
 *
 * Every conversion from storage gives each row a fresh id and rows are keyed by
 * id, so when the merge compared tables with their ids, each save's answer
 * replaced every Params and Headers row with a fresh-id copy: the input being
 * typed into was unmounted and the caret went to `<body>`. And an outside write
 * to any field, landing over an unsaved table edit, raised "Changed elsewhere"
 * on that table though nobody touched it.
 *
 * Real builder, provider, query client, Headers and Params panels; only
 * `GET` / `PUT /requests/:id` are stubbed, and the PUT answers with what it was
 * sent, its rows' members in the engine's stored order.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { apiService } from "@/services/api";
import { useRequestQuery } from "@/queries";
import { queryKeys } from "@/queries/keys";
import { useClientSettingsStore, useTabsStore } from "@/stores";
import type { KeyValueEntry, Request, UpdateRequestRequest } from "@/types";
import { useRequestBuilderContext } from "./context/RequestBuilderContext";
import HeadersPanel from "./components/RequestTabs/panels/HeadersPanel";
import ParamsPanel from "./components/RequestTabs/panels/ParamsPanel";

function Probe() {
	const { request, fieldConflicts, saveRequest } = useRequestBuilderContext();
	// An observer of the same query: once it shows a write's `updatedAt`, the
	// builder's own observer has been notified in the same batch.
	const { data: cached } = useRequestQuery("req_1");
	return (
		<>
			<span data-testid="name">{request.name}</span>
			<span data-testid="conflicts">{Object.keys(fieldConflicts).join(",")}</span>
			<span data-testid="cached-at">{cached?.updatedAt}</span>
			<button onClick={() => void saveRequest()}>save</button>
		</>
	);
}

// The layout renders Monaco and the response tree; the two tables are the subject.
vi.mock("./components/RequestBuilderLayout", () => ({
	default: () => (
		<TooltipProvider>
			<Probe />
			<HeadersPanel />
			<ParamsPanel />
		</TooltipProvider>
	),
}));

const { default: RequestBuilder } = await import("./index");

const STORED = {
	id: "req_1",
	collectionId: "col_1",
	name: "List users",
	method: "GET",
	url: "https://api.test/users",
	params: [],
	headers: [{ key: "X-One", value: "1", enabled: true }],
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

const SAVED_AT = "2026-01-02T00:00:00.000Z";

/** A row as the engine hands it back: stored as JSON, its members sorted. */
const asStored = (rows: KeyValueEntry[]): KeyValueEntry[] =>
	rows.map(
		(row) =>
			Object.fromEntries(
				Object.entries(row).sort(([a], [b]) => a.localeCompare(b))
			) as unknown as KeyValueEntry
	);

let server: Request;

beforeEach(() => {
	server = { ...STORED };
	// Every other read the pane makes waits forever: they are not the subject.
	vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
	vi.spyOn(apiService, "getRequest").mockImplementation(() => Promise.resolve({ ...server }));
	vi.spyOn(apiService, "updateRequest").mockImplementation((data: UpdateRequestRequest) => {
		server = {
			...server,
			...(data.url !== undefined && { url: data.url }),
			...(data.params && { params: asStored(data.params) }),
			...(data.headers && { headers: asStored(data.headers) }),
			updatedAt: SAVED_AT,
		};
		return Promise.resolve({ ...server });
	});
	// The test saves by hand, so the save it waits for is the only one.
	useClientSettingsStore.getState().setAutoSave({ enabled: false });
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "List users" } as never],
		activeTabId: "t1",
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

/** Type into `input` the way a user does: focused first, then changed. */
function typeInto(input: HTMLInputElement, value: string) {
	act(() => input.focus());
	fireEvent.change(input, { target: { value } });
}

/** Save, and wait until the builder has been handed the PUT's answer. */
async function saveAndAwaitEcho() {
	fireEvent.click(screen.getByText("save"));
	await waitFor(() => expect(shown("cached-at")).toBe(SAVED_AT));
}

describe("a table row across the save's own echo", () => {
	it("keeps the header value input being typed into mounted and focused", async () => {
		renderOpenRequest();
		const input = (await screen.findByDisplayValue("1")) as HTMLInputElement;

		typeInto(input, "2");
		await saveAndAwaitEcho();

		expect(apiService.updateRequest).toHaveBeenCalledWith(
			expect.objectContaining({ headers: [{ key: "X-One", value: "2", enabled: true }] })
		);
		expect(input.isConnected).toBe(true);
		expect(document.activeElement).toBe(input);
		expect(input.value).toBe("2");
		expect(shown("conflicts")).toBe("");
	});

	it("keeps a params row with a value and no key yet", async () => {
		renderOpenRequest();
		await screen.findByDisplayValue("1");
		// The Params table renders after the Headers table: its spare row's value.
		const values = screen.getAllByPlaceholderText("Value") as HTMLInputElement[];
		const spareValue = values[values.length - 1];

		typeInto(spareValue, "half-typed");
		await saveAndAwaitEcho();

		expect(apiService.updateRequest).toHaveBeenCalledWith(
			expect.objectContaining({ params: [{ key: "", value: "half-typed", enabled: true }] })
		);
		expect(spareValue.isConnected).toBe(true);
		expect(document.activeElement).toBe(spareValue);
		expect(spareValue.value).toBe("half-typed");
	});
});

describe("an outside write over an unsaved table edit", () => {
	it("renames the request without calling the untouched header rows changed elsewhere", async () => {
		const client = renderOpenRequest();
		const input = (await screen.findByDisplayValue("1")) as HTMLInputElement;
		typeInto(input, "2");

		// Another window renames the request; its refetch lands while the header
		// edit is still unsaved.
		act(() => {
			client.setQueryData(queryKeys.requests.detail("req_1"), {
				...server,
				name: "Renamed elsewhere",
				updatedAt: SAVED_AT,
			});
		});
		await waitFor(() => expect(shown("name")).toBe("Renamed elsewhere"));

		expect(shown("conflicts")).toBe("");
		expect(input.isConnected).toBe(true);
		expect(input.value).toBe("2");
	});

	it("keeps a caret in the Params spare row when an outside write adds a param", async () => {
		const client = renderOpenRequest();
		await screen.findByDisplayValue("1");
		const spareKey = screen.getByPlaceholderText("Parameter") as HTMLInputElement;
		act(() => spareKey.focus());

		act(() => {
			client.setQueryData(queryKeys.requests.detail("req_1"), {
				...server,
				url: "https://api.test/users?page=1",
				params: [{ enabled: true, key: "page", value: "1" }],
				updatedAt: SAVED_AT,
			});
		});
		await waitFor(() =>
			expect(
				screen
					.getAllByPlaceholderText("Parameter")
					.map((el) => (el as HTMLInputElement).value)
			).toEqual(["page", ""])
		);

		expect(spareKey.isConnected).toBe(true);
		expect(document.activeElement).toBe(spareKey);
	});
});
