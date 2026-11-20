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
 * Rows and a file chosen for one body mode survive a save made in another
 * (#3665).
 *
 * A request stores one body, so after a save in JSON mode the record holds no
 * form rows and no binary file. `initialRequest` used to name `formData`,
 * `urlEncoded` and `binaryFile` anyway, empty, and the per-field merge adopted
 * that as an outside write: Form data, JSON, wait for the autosave, Form data
 * again showed an empty table. The raw text survives the same trip through
 * GraphQL (`utils/body-drafts.ts`), so the two halves of the feature disagreed.
 *
 * Real builder, provider and query client; `GET` / `PUT /requests/:id` are
 * stubbed and the PUT stores the body it was sent, which is the echo the
 * builder then reads. The mode is switched through `updateField`, as the body
 * panel's selector does: a Radix `Select` does not commit in jsdom.
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
import type { BodyMode } from "./types";

const MODES: BodyMode[] = ["json", "form-data", "x-www-form-urlencoded", "binary"];

function Probe() {
	const { request, updateField, saveRequest } = useRequestBuilderContext();
	// An observer of the same query: once it shows a write's `updatedAt`, the
	// builder's own observer has been notified in the same batch.
	const { data: cached } = useRequestQuery("req_1");
	const typed = (rows: typeof request.formData) =>
		rows
			.filter((row) => row.key)
			.map((row) => [row.key, row.value, row.type, row.src].join("|"))
			.join(" ");
	return (
		<>
			<span data-testid="name">{request.name}</span>
			<span data-testid="bodyMode">{request.bodyMode}</span>
			<span data-testid="formData">{typed(request.formData)}</span>
			<span data-testid="urlEncoded">{typed(request.urlEncoded)}</span>
			<span data-testid="binaryFile">{request.binaryFile.src}</span>
			<span data-testid="cached-at">{cached?.updatedAt}</span>
			{MODES.map((mode) => (
				<button key={mode} onClick={() => updateField("bodyMode", mode)}>
					to {mode}
				</button>
			))}
			<button onClick={() => void saveRequest()}>save</button>
		</>
	);
}

// The layout renders Monaco and the response tree; the body state is the subject.
vi.mock("./components/RequestBuilderLayout", () => ({ default: () => <Probe /> }));

const { default: RequestBuilder } = await import("./index");

const SAVED_AT = "2026-01-02T00:00:00.000Z";

const storedRequest = (id: string, name: string, body: RequestBody) =>
	({
		id,
		collectionId: "col_1",
		name,
		method: "GET",
		url: "https://api.test/users",
		params: [],
		headers: [],
		body,
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

const FORM_BODY: RequestBody = {
	mode: "form-data",
	fields: [
		{ key: "alpha", value: "1", enabled: true },
		{ key: "beta", value: "2", enabled: true },
		{ key: "upload", value: "", enabled: true, type: "file", src: "/tmp/a.txt" },
	],
};

const URL_ENCODED_BODY: RequestBody = {
	mode: "x-www-form-urlencoded",
	fields: [
		{ key: "alpha", value: "1", enabled: true },
		{ key: "beta", value: "2", enabled: true },
	],
};

const BINARY_BODY: RequestBody = {
	mode: "binary",
	file: { src: "/tmp/data.bin", fileName: "data.bin" },
};

let servers: Record<string, Request>;

beforeEach(() => {
	servers = {
		req_2: storedRequest("req_2", "Other request", { mode: "json", content: "{}" }),
	};
	// Every other read the pane makes waits forever: they are not the subject.
	vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
	vi.spyOn(apiService, "getRequest").mockImplementation((id: string) =>
		Promise.resolve({ ...servers[id] })
	);
	vi.spyOn(apiService, "updateRequest").mockImplementation((data: UpdateRequestRequest) => {
		servers[data.id] = {
			...servers[data.id],
			...(data.body && { body: data.body }),
			updatedAt: SAVED_AT,
		} as Request;
		return Promise.resolve({ ...servers[data.id] });
	});
	// The test saves by hand, so the save it waits for is the only one.
	useClientSettingsStore.getState().setAutoSave({ enabled: false });
	openTab("req_1");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function openTab(entityId: string) {
	act(() => {
		useTabsStore.setState({
			openTabs: [
				{ id: `t_${entityId}`, type: "request", entityId, title: entityId } as never,
			],
			activeTabId: `t_${entityId}`,
		});
	});
}

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
const switchTo = (mode: BodyMode) => fireEvent.click(screen.getByText(`to ${mode}`));

/** Save, and wait until the builder has been handed the PUT's answer. */
async function saveAndAwaitEcho() {
	fireEvent.click(screen.getByText("save"));
	await waitFor(() => expect(shown("cached-at")).toBe(SAVED_AT));
}

describe.each([
	{ mode: "form-data", field: "formData", stored: FORM_BODY },
	{ mode: "x-www-form-urlencoded", field: "urlEncoded", stored: URL_ENCODED_BODY },
	{ mode: "binary", field: "binaryFile", stored: BINARY_BODY },
] as const)("$mode content across a save made in JSON mode", ({ mode, field, stored }) => {
	beforeEach(() => {
		servers.req_1 = storedRequest("req_1", "Upload", stored);
	});

	/** Open the request, leave `mode` for JSON and let the save's echo land. */
	async function leaveForJsonAndSave(): Promise<string> {
		renderOpenRequest();
		await waitFor(() => expect(shown("bodyMode")).toBe(mode));
		const before = shown(field) ?? "";
		expect(before).not.toBe("");

		switchTo("json");
		await saveAndAwaitEcho();
		expect(servers.req_1.body.mode).toBe("json");
		return before;
	}

	it("is still there when the mode is chosen again", async () => {
		const before = await leaveForJsonAndSave();

		switchTo(mode);

		expect(shown("bodyMode")).toBe(mode);
		expect(shown(field)).toBe(before);
	});

	it("is not inherited by another request opened in the tab", async () => {
		await leaveForJsonAndSave();

		openTab("req_2");
		await waitFor(() => expect(shown("name")).toBe("Other request"));
		switchTo(mode);

		expect(shown(field)).toBe("");
	});
});

describe("an outside write in the same mode that empties it", () => {
	// The record's answer for the mode it holds is taken as is, empty or not:
	// the omission applies to other modes only.
	it.each([
		{ field: "formData", stored: FORM_BODY, emptied: { mode: "form-data", fields: [] } },
		{
			field: "binaryFile",
			stored: BINARY_BODY,
			emptied: { mode: "binary", file: { src: "" } },
		},
	] as const)("is adopted for $field", async ({ field, stored, emptied }) => {
		servers.req_1 = storedRequest("req_1", "Upload", stored);
		const client = renderOpenRequest();
		await waitFor(() => expect(shown(field)).not.toBe(""));

		act(() => {
			client.setQueryData(queryKeys.requests.detail("req_1"), {
				...servers.req_1,
				body: emptied,
				updatedAt: SAVED_AT,
			});
		});

		await waitFor(() => expect(shown(field)).toBe(""));
	});
});
