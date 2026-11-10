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
 * A write to the open request by any other client reaches its tab (issue
 * #3420). The whole path is real but the two ends: the change feed's frames
 * come from a recorder standing in for `EventSource`, and `GET /requests/:id`
 * answers from a stub that the "other client" rewrites. Between them run the
 * feed's mapping, the request's detail query, `index.tsx`'s row-to-draft
 * mapping and `RequestBuilderProvider`'s per-field merge (#1436), so the test
 * says what the user sees: the untouched field adopts the new value, and the
 * field they were typing keeps the draft and shows the conflict.
 */

import type { ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { ChangeFeedService } from "@/services/change-feed-service";
import { useClientSettingsStore, useTabsStore } from "@/stores";
import type { Request } from "@/types";
import { useRequestBuilderContext } from "./context/RequestBuilderContext";

/** Shows what the cases read off the draft, and offers the edit they make. */
function DraftProbe() {
	const { request, updateField, fieldConflicts } = useRequestBuilderContext();
	return (
		<>
			<span data-testid="url">{request.url}</span>
			<span data-testid="description">{request.description}</span>
			<span data-testid="conflicts">{Object.keys(fieldConflicts).sort().join(",")}</span>
			<span data-testid="conflict-description">
				{String(fieldConflicts.description ?? "")}
			</span>
			<button onClick={() => updateField("description", "my draft")}>type description</button>
		</>
	);
}

// The layout renders Monaco and the response tree; the draft is the subject.
vi.mock("./components/RequestBuilderLayout", () => ({ default: () => <DraftProbe /> }));

const { default: RequestBuilder } = await import("./index");

/** Every source the service opened, with its listeners reachable. */
class MockEventSource {
	static instances: MockEventSource[] = [];
	onerror: (() => void) | null = null;
	private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

	constructor(readonly url: string) {
		MockEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: (event: MessageEvent) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	close() {}

	emit(type: string, id: number, data: unknown) {
		const event = new MessageEvent(type, {
			lastEventId: String(id),
			data: JSON.stringify(data),
		});
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

const STORED: Request = {
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

let stored: Request;
let service: ChangeFeedService;

beforeEach(() => {
	MockEventSource.instances = [];
	vi.stubGlobal("EventSource", MockEventSource);
	// Every other read the pane makes waits forever: they are not the subject,
	// and a refused connection would only add noise.
	vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
	stored = STORED;
	vi.spyOn(apiService, "getRequest").mockImplementation(async () => ({ ...stored }));
	// The edit must stay a draft: an autosave would make the field agree with
	// the server and leave nothing to conflict over.
	useClientSettingsStore.getState().setAutoSave({ enabled: false });
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Get user" } as never],
		activeTabId: "t1",
	});
	service = new ChangeFeedService();
});

afterEach(() => {
	service.stop();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function renderOpenRequest() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	render(<RequestBuilder />, { wrapper });
	service.start(queryClient);
	const feed = MockEventSource.instances[MockEventSource.instances.length - 1];
	feed.emit("ready", 100, { lastEventId: 100 });
	return feed;
}

const shown = (testId: string) => screen.getByTestId(testId).textContent;

describe("a write to the open request by another client", () => {
	it("adopts an untouched field and keeps a typed one as a conflict", async () => {
		const feed = renderOpenRequest();
		expect(await screen.findByTestId("url")).toHaveProperty("textContent", STORED.url);

		act(() => screen.getByText("type description").click());
		expect(shown("description")).toBe("my draft");

		// Someone else's `PUT /requests/req_1`, and the event the engine relays.
		stored = { ...STORED, url: "https://api.test/v2", description: "their description" };
		act(() =>
			feed.emit("change", 101, {
				kind: "request",
				id: "req_1",
				op: "update",
				collectionId: "col_1",
			})
		);

		await waitFor(() => expect(shown("url")).toBe("https://api.test/v2"));
		expect(shown("description")).toBe("my draft");
		expect(shown("conflicts")).toBe("description");
		expect(shown("conflict-description")).toBe("their description");
	});
});
