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
 * "Copy for agent" in a tab's right-click menu (#2047).
 *
 * The line comes from `useTabDescriptors`, which holds the entity each tab
 * shows, so the failure pinned here is a menu item that copies what the strip
 * *draws* instead: a request tab's label is its resolved URL when it has no
 * name, and a run tab's is the URL path the run was sent to. Every fixture
 * carries a sentinel where a secret would live (a header, a variable, the auth,
 * the URL's query), and no copied line may contain it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabStrip } from "./TabStrip";
import { formatInstant } from "@/lib/time-value";
import { useTabsStore, useToastStore, type Tab } from "@/stores";

const SENTINEL = "s3cr3t-sentinel";
const START = 1_750_000_000_000;

const COLLECTIONS = [
	{ id: "acme", name: "Acme API", parentId: undefined, order: 0, variables: {} },
	{
		id: "col_billing",
		name: "Billing",
		parentId: "acme",
		order: 0,
		variables: { apiKey: { value: SENTINEL, secret: true } },
	},
];

const REQUESTS: Record<string, unknown> = {
	req_1: {
		id: "req_1",
		collectionId: "col_billing",
		name: "Get customer",
		method: "GET",
		url: `https://api.example.test/v1/customers/42?token=${SENTINEL}`,
		params: [],
		headers: [{ key: "X-Key", value: SENTINEL, enabled: true }],
		auth: { mode: "bearer", bearer: { token: SENTINEL } },
	},
};

const RUNS: Record<string, unknown> = {
	run_design: {
		id: "run_design",
		type: "design",
		status: "completed",
		startTime: START,
		endTime: START + 1000,
		configSnapshot: {
			url: `https://api.example.test/checkout?token=${SENTINEL}`,
			method: "POST",
			requestName: "Checkout",
			headers: { "X-Key": SENTINEL },
			auth: { mode: "bearer", bearer: { token: SENTINEL } },
		},
	},
	run_scenario: {
		id: "run_scenario",
		type: "scenario",
		status: "failed",
		startTime: START,
		endTime: START + 1000,
		configSnapshot: { scenario: { collectionId: "acme", steps: [] } },
	},
};

const INBOXES = [
	{ inboxId: "inbox_high", port: 42000, url: `http://127.0.0.1:42000/?k=${SENTINEL}` },
	{ inboxId: "inbox_low", port: 41000, url: `http://127.0.0.1:41000/?k=${SENTINEL}` },
];

const MOCKS = [
	{
		mockId: "mock_1",
		collectionName: "Acme API",
		port: 43000,
		url: `http://127.0.0.1:43000/?k=${SENTINEL}`,
	},
];

vi.mock("@/queries", () => ({
	requestDetailOptions: (id: string | null) => ({
		queryKey: ["request", id],
		queryFn: async () => (id ? REQUESTS[id] : undefined),
		initialData: id ? REQUESTS[id] : undefined,
		enabled: false,
	}),
	runDetailOptions: (id: string | null) => ({
		queryKey: ["run", id],
		queryFn: async () => (id ? RUNS[id] : undefined),
		initialData: id ? RUNS[id] : undefined,
		enabled: false,
	}),
	useCollectionsQuery: () => ({ data: COLLECTIONS }),
	useInboxesQuery: () => ({ data: INBOXES }),
	useMockServersQuery: () => ({ data: MOCKS }),
}));

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString: (s: string) => s }),
}));

const writeText = vi.fn();

beforeEach(() => {
	cleanup();
	writeText.mockReset().mockResolvedValue(undefined);
	// jsdom ships no clipboard, and `useCopy` reports a rejection rather than
	// claiming a copy that did not happen - so the stub has to resolve.
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

function openMenuOn(tab: Omit<Tab, "id">) {
	useTabsStore.setState({
		openTabs: [{ id: "t1", ...tab }],
		activeTabId: "t1",
		navHistory: [],
		navIndex: -1,
	});
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TabStrip />
		</QueryClientProvider>
	);
	fireEvent.contextMenu(document.querySelector<HTMLElement>('[data-tab-id="t1"]')!);
}

async function copyForAgent(tab: Omit<Tab, "id">): Promise<string> {
	openMenuOn(tab);
	fireEvent.click(await screen.findByRole("menuitem", { name: /Copy for agent/ }));
	await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
	const copied = writeText.mock.calls[0][0] as string;
	expect(copied).not.toContain(SENTINEL);
	return copied;
}

describe("Copy for agent in the tab menu", () => {
	it("names a request by its own name and collection chain, and says so", async () => {
		const copied = await copyForAgent({ type: "request", entityId: "req_1" });

		expect(copied).toBe('Vayu request "Get customer" (req_1) in Acme API / Billing');
		await waitFor(() =>
			expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
				"Reference copied",
			])
		);
	});

	it("names a collection with the chain above it", async () => {
		expect(await copyForAgent({ type: "collection", entityId: "col_billing" })).toBe(
			'Vayu collection "Billing" (col_billing) in Acme API'
		);
	});

	it("names a design run from its snapshot, the url cut to its path", async () => {
		expect(await copyForAgent({ type: "run", entityId: "run_design" })).toBe(
			`Vayu run "Checkout" (run_design) - design run, POST /checkout, ${formatInstant(START, "datetime")}, completed`
		);
	});

	it("names a collection run by the collection it ran", async () => {
		expect(await copyForAgent({ type: "run", entityId: "run_scenario" })).toBe(
			`Vayu run "Acme API" (run_scenario) - collection run, collection "Acme API", ${formatInstant(START, "datetime")}, failed`
		);
	});

	it("names the inbox the tab addresses", async () => {
		expect(await copyForAgent({ type: "inbox", entityId: "inbox_high" })).toBe(
			'Vayu inbox "port 42000" (inbox_high)'
		);
	});

	it("names the lowest-port inbox for a tab with no address, the one it shows", async () => {
		expect(await copyForAgent({ type: "inbox", entityId: null })).toBe(
			'Vayu inbox "port 41000" (inbox_low)'
		);
	});

	it("names the mock server the tab addresses", async () => {
		expect(await copyForAgent({ type: "mock-server", entityId: "mock_1" })).toBe(
			'Vayu mock server "Acme API on port 43000" (mock_1)'
		);
	});

	it("offers none on a tab that names no entity", async () => {
		openMenuOn({ type: "settings", entityId: null });

		await screen.findByRole("menuitem", { name: "Close" });
		expect(screen.queryByRole("menuitem", { name: /Copy for agent/ })).toBeNull();
	});

	it("offers none on a request tab until its request has loaded", async () => {
		openMenuOn({ type: "request", entityId: "req_unloaded" });

		await screen.findByRole("menuitem", { name: "Close" });
		expect(screen.queryByRole("menuitem", { name: /Copy for agent/ })).toBeNull();
	});
});
