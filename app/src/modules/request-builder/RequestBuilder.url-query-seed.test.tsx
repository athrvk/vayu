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
 * A request stored with its query only in `url` opens with those pairs as
 * Params rows (issue #3491). It used to open with an empty table, and the first
 * edit of the table rebuilt the URL from its rows alone, deleting the query the
 * request had been sent with.
 *
 * Real builder, provider and Params panel; only `GET /requests/:id` is stubbed.
 * The seed is `index.tsx`'s, so what is asserted is what a user sees on open
 * and after the first edit, and that opening is not an edit.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { apiService } from "@/services/api";
import { useClientSettingsStore, useTabsStore } from "@/stores";
import type { Request } from "@/types";
import { useRequestBuilderContext } from "./context/RequestBuilderContext";
import ParamsPanel from "./components/RequestTabs/panels/ParamsPanel";

function Probe() {
	const { request, hasUnsavedChanges } = useRequestBuilderContext();
	return (
		<>
			<span data-testid="url">{request.url}</span>
			<span data-testid="dirty">{String(hasUnsavedChanges)}</span>
		</>
	);
}

// The layout renders Monaco and the response tree; the Params table is the subject.
vi.mock("./components/RequestBuilderLayout", () => ({
	default: () => (
		<TooltipProvider>
			<Probe />
			<ParamsPanel />
		</TooltipProvider>
	),
}));

const { default: RequestBuilder } = await import("./index");

const QUERY_ONLY_IN_URL = {
	id: "req_1",
	collectionId: "col_1",
	name: "List users",
	method: "GET",
	url: "https://api.test/users?page=1&limit=5",
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

beforeEach(() => {
	// Every other read the pane makes waits forever: they are not the subject.
	vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
	vi.spyOn(apiService, "getRequest").mockResolvedValue({ ...QUERY_ONLY_IN_URL });
	// An autosave would clear the dirty flag the second case reads.
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

function renderOpenRequest() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<RequestBuilder />
		</QueryClientProvider>
	);
}

/** The query table's key fields: every parameter box outside the path section. */
const keyFields = () => screen.getAllByPlaceholderText("Parameter") as HTMLInputElement[];
const shown = (testId: string) => screen.getByTestId(testId).textContent;

describe("a request whose query is only in its URL", () => {
	it("opens with the URL's pairs as rows, and is not marked unsaved", async () => {
		renderOpenRequest();
		await screen.findByTestId("url");

		// Two pairs and the spare row to type into.
		expect(keyFields().map((el) => el.value)).toEqual(["page", "limit", ""]);
		expect(shown("dirty")).toBe("false");
	});

	it("keeps the URL's pairs when a row is added to the table", async () => {
		renderOpenRequest();
		await screen.findByTestId("url");

		const spare = keyFields()[2];
		fireEvent.change(spare, { target: { value: "sort" } });

		expect(shown("url")).toBe("https://api.test/users?page=1&limit=5&sort=");
		expect(shown("dirty")).toBe("true");
	});
});
