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
 * The services an engine crash took with it, named once the user restarts it
 * (#3493).
 *
 * Rendered end to end because the defect is in the wiring: the crash is
 * recorded by the health poll, the restart is the Dock's button, and both
 * reconnect paths (`useHealthQuery` and `useEngineRestart`) report the same
 * outage. One notice must come out of the two.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const getHealth = vi.fn();
const listInboxes = vi.fn();
const listMockIssuers = vi.fn();
const listMockServers = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: {
		getHealth: () => getHealth(),
		listInboxes: () => listInboxes(),
		listMockIssuers: () => listMockIssuers(),
		listMockServers: () => listMockServers(),
	},
}));

// The restart's settle wait is a real 1.5 s timer; the order of the two
// reports is what this file is about, not that wait.
vi.mock("@/config/timing", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/config/timing")>();
	return { ...actual, TIMING: { ...actual.TIMING, ENGINE_RESTART_WAIT_MS: 0 } };
});

import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import Toaster from "@/components/shared/Toaster";
import { Dock } from "./Dock";
import { useHealthQuery } from "@/queries/health";
import { useEngineLifecycle } from "@/hooks/useEngineLifecycle";
import { queryKeys } from "@/queries/keys";
import { useEngineStore, useToastStore } from "@/stores";
import { resetServicesBeforeOutageForTests } from "@/lib/services-stopped-by-restart";
import type { EngineLifecyclePayload } from "@/types/electron";
import type { Inbox, MockIssuer, MockServer } from "@/types";

vi.stubGlobal("__VAYU_VERSION__", "0.0.0-test");

const NOTICE =
	"The inbox on port 41234, the inbox on port 41235, and the mock server for 'Orders API' on port 5050 stopped when Vayu's engine restarted. Start them again from Services.";

const restartEngine = vi.fn();
let lifecycleListener: ((lifecycle: EngineLifecyclePayload) => void) | null = null;

function HealthPoll() {
	useHealthQuery();
	return null;
}

function Lifecycle() {
	useEngineLifecycle();
	return null;
}

function renderApp(client: QueryClient) {
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<HealthPoll />
				<Lifecycle />
				<Dock />
				<Toaster />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** Every `showToast` call that carried the notice, deduplicated or not. */
const noticesRaised = vi.fn();

beforeEach(() => {
	cleanup();
	vi.clearAllMocks();
	resetServicesBeforeOutageForTests();
	useEngineStore.setState({
		engineStatus: "starting",
		engineError: null,
		engineStartWindow: null,
		engineCrash: null,
		engineStartFailure: null,
		pendingRestart: false,
		engineRestarting: false,
		restartRequiredKeys: [],
	});
	// The store dedups an identical message, which would hide a second raise.
	useToastStore.setState({ toasts: [] });
	const { showToast } = useToastStore.getState();
	useToastStore.setState({
		showToast: (input, variant) => {
			if (typeof input !== "string" && input.message === NOTICE) noticesRaised();
			return showToast(input, variant);
		},
	});
	restartEngine.mockResolvedValue({ success: true });
	lifecycleListener = null;
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		restartEngine,
		getEngineLifecycle: () => Promise.resolve({ kind: "ready" }),
		onEngineLifecycle: (listener: (lifecycle: EngineLifecyclePayload) => void) => {
			lifecycleListener = listener;
			return () => undefined;
		},
	};
});

function pushCrash() {
	act(() =>
		lifecycleListener?.({
			kind: "crashed",
			code: null,
			signal: "SIGKILL",
			stderrTail: [],
			error: null,
		})
	);
}

describe("after Vayu's engine crashes and is restarted", () => {
	it("names the services that stopped, once, though both reconnect paths report", async () => {
		getHealth.mockResolvedValue({ status: "ok", version: "1.0.0", workers: 8 });
		listInboxes.mockResolvedValue([
			{ inboxId: "in-a", port: 41234, running: true },
			{ inboxId: "in-b", port: 41235, running: true },
		] as Inbox[]);
		listMockIssuers.mockResolvedValue([]);
		listMockServers.mockResolvedValue([
			{ mockId: "mk-1", port: 5050, collectionName: "Orders API" },
		] as MockServer[]);

		const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
		renderApp(client);
		await waitFor(() => expect(screen.getByText("Engine connected")).toBeTruthy());
		// The Dock's own count reads the lists, so the cache holds what ran.
		await waitFor(() =>
			expect(client.getQueryData(queryKeys.mockServer.list())).toHaveLength(1)
		);

		getHealth.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9876"));
		pushCrash();
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("unreachable"));

		// The engine the restart brings up is running nothing.
		getHealth.mockResolvedValue({ status: "ok", version: "1.0.0", workers: 8 });
		listInboxes.mockResolvedValue([]);
		listMockServers.mockResolvedValue([]);
		fireEvent.click(screen.getByRole("button", { name: "Restart" }));

		// Both paths have reported: the poll saw the engine come back after a
		// failure, and the restart ran to its end.
		await act(async () => {
			await client.refetchQueries({ queryKey: queryKeys.health.status() });
		});
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("connected"));
		await waitFor(() => expect(restartEngine).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(useEngineStore.getState().engineRestarting).toBe(false));

		expect(await screen.findByText(NOTICE)).toBeTruthy();
		await waitFor(() => expect(client.isFetching()).toBe(0));
		// Mutation-check: leave the snapshot pending after a report and this is 2.
		expect(noticesRaised).toHaveBeenCalledTimes(1);
	});

	it("names what stopped when the engine comes back with no restart from this window", async () => {
		// Restarted outside the Dock's button (by hand, or by another client): the
		// health poll's reconnect is the only path that sees it.
		getHealth.mockResolvedValue({ status: "ok", version: "1.0.0", workers: 8 });
		listInboxes.mockResolvedValue([]);
		listMockIssuers.mockResolvedValue([{ issuerId: "is-1", port: 6000 }] as MockIssuer[]);
		listMockServers.mockResolvedValue([]);

		const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
		renderApp(client);
		await waitFor(() => expect(screen.getByText("Engine connected")).toBeTruthy());
		await waitFor(() =>
			expect(client.getQueryData(queryKeys.mockIssuer.list())).toHaveLength(1)
		);

		getHealth.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9876"));
		pushCrash();
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("unreachable"));

		getHealth.mockResolvedValue({ status: "ok", version: "1.0.0", workers: 8 });
		listMockIssuers.mockResolvedValue([]);
		// Mutation-check: drop the record in `useHealthQuery` and nothing is named.
		await act(async () => {
			await client.refetchQueries({ queryKey: queryKeys.health.status() });
		});

		expect(
			await screen.findByText(
				"The OAuth issuer on port 6000 stopped when Vayu's engine restarted. Start it again from Services."
			)
		).toBeTruthy();
		expect(restartEngine).not.toHaveBeenCalled();
	});

	it("says nothing when the restarted engine is still running everything", async () => {
		// A manual restart with no failed poll: the restart path alone reports.
		getHealth.mockResolvedValue({ status: "ok", version: "1.0.0", workers: 8 });
		const inboxes = [{ inboxId: "in-a", port: 41234, running: true }] as Inbox[];
		listInboxes.mockResolvedValue(inboxes);
		listMockIssuers.mockResolvedValue([]);
		listMockServers.mockResolvedValue([]);
		useEngineStore.getState().addRestartRequiredKey("dbCacheSize");

		const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
		renderApp(client);
		await waitFor(() => expect(screen.getByText("Engine connected")).toBeTruthy());
		await waitFor(() => expect(client.getQueryData(queryKeys.inbox.list())).toHaveLength(1));

		fireEvent.click(screen.getByRole("button", { name: /Restart pending/i }));
		await waitFor(() => expect(restartEngine).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(useEngineStore.getState().engineRestarting).toBe(false));
		await waitFor(() => expect(client.isFetching()).toBe(0));

		expect(listInboxes.mock.calls.length).toBeGreaterThan(1);
		expect(noticesRaised).not.toHaveBeenCalled();
		expect(screen.queryByText(/stopped when Vayu's engine restarted/)).toBeNull();
	});

	it("names what a manual restart stopped, with no failed poll behind it", async () => {
		getHealth.mockResolvedValue({ status: "ok", version: "1.0.0", workers: 8 });
		listInboxes.mockResolvedValue([{ inboxId: "in-a", port: 41234, running: true }] as Inbox[]);
		listMockIssuers.mockResolvedValue([]);
		listMockServers.mockResolvedValue([]);
		useEngineStore.getState().addRestartRequiredKey("dbCacheSize");

		const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
		renderApp(client);
		await waitFor(() => expect(screen.getByText("Engine connected")).toBeTruthy());
		await waitFor(() => expect(client.getQueryData(queryKeys.inbox.list())).toHaveLength(1));

		listInboxes.mockResolvedValue([]);
		// Mutation-check: drop the record or the report in `useEngineRestart` and
		// nothing is named.
		fireEvent.click(screen.getByRole("button", { name: /Restart pending/i }));

		expect(
			await screen.findByText(
				"The inbox on port 41234 stopped when Vayu's engine restarted. Start it again from Services."
			)
		).toBeTruthy();
	});
});
