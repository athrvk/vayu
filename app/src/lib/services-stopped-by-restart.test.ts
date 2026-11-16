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
 * An engine restart takes every service with it, and the drawer then reads
 * like a first run (#3493). These pin the comparison, the copy and the one
 * pending snapshot; `Dock.services-stopped.test.tsx` drives both reconnect
 * paths through the real hooks.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const listInboxes = vi.fn();
const listMockIssuers = vi.fn();
const listMockServers = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: {
		listInboxes: () => listInboxes(),
		listMockIssuers: () => listMockIssuers(),
		listMockServers: () => listMockServers(),
	},
}));

import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/keys";
import { useLayoutStore, useToastStore } from "@/stores";
import type { Inbox, MockIssuer, MockServer } from "@/types";
import {
	recordServicesBeforeOutage,
	reportServicesStoppedByOutage,
	resetServicesBeforeOutageForTests,
	runningServicesIn,
	servicesStopped,
	servicesStoppedNotice,
} from "./services-stopped-by-restart";

function inbox(inboxId: string, port: number, running = true): Inbox {
	return { inboxId, port, running } as Inbox;
}

function issuer(issuerId: string, port: number): MockIssuer {
	return { issuerId, port } as MockIssuer;
}

function mock(mockId: string, port: number, collectionName: string): MockServer {
	return { mockId, port, collectionName } as MockServer;
}

const showToast = vi.fn();

function cacheServices(
	client: QueryClient,
	lists: { inboxes?: Inbox[]; issuers?: MockIssuer[]; mocks?: MockServer[] }
): void {
	if (lists.inboxes) client.setQueryData(queryKeys.inbox.list(), lists.inboxes);
	if (lists.issuers) client.setQueryData(queryKeys.mockIssuer.list(), lists.issuers);
	if (lists.mocks) client.setQueryData(queryKeys.mockServer.list(), lists.mocks);
}

function engineNowRuns(lists: { inboxes?: Inbox[]; issuers?: MockIssuer[]; mocks?: MockServer[] }) {
	listInboxes.mockResolvedValue(lists.inboxes ?? []);
	listMockIssuers.mockResolvedValue(lists.issuers ?? []);
	listMockServers.mockResolvedValue(lists.mocks ?? []);
}

const notices = () => showToast.mock.calls.map(([opts]) => (opts as { message: string }).message);

beforeEach(() => {
	vi.clearAllMocks();
	resetServicesBeforeOutageForTests();
	useToastStore.setState({ showToast });
});

describe("servicesStopped", () => {
	const before = runningServicesIn({
		inboxes: [inbox("in-a", 41234), inbox("in-b", 41235)],
		mocks: [mock("mk-1", 5050, "Orders API")],
	});

	it("names every service the fresh lists no longer hold", () => {
		// Mutation-check: return `before` unfiltered and the second case fails;
		// return `[]` and this one does.
		expect(servicesStopped(before, []).map((s) => s.id)).toEqual(["in-a", "in-b", "mk-1"]);
	});

	it("leaves out an inbox that is still running, and keeps one that is listed stopped", () => {
		// Engine startup can keep a lost inbox's record with `running: false`
		// rather than drop it; both read as stopped.
		const after = runningServicesIn({
			inboxes: [inbox("in-a", 41234), inbox("in-b", 41235, false)],
			mocks: [],
		});
		expect(servicesStopped(before, after).map((s) => s.id)).toEqual(["in-b", "mk-1"]);
	});

	it("compares by id, not by port", () => {
		// A fresh inbox can land on the port a lost one held.
		const after = runningServicesIn({ inboxes: [inbox("in-new", 41234)] });
		expect(servicesStopped(before, after).map((s) => s.id)).toContain("in-a");
	});

	it("never counts a service that was already stopped before the outage", () => {
		const stoppedBefore = runningServicesIn({ inboxes: [inbox("in-a", 41234, false)] });
		expect(servicesStopped(stoppedBefore, [])).toEqual([]);
	});
});

describe("servicesStoppedNotice", () => {
	it("names each service the way the drawer lists it", () => {
		const stopped = runningServicesIn({
			inboxes: [inbox("in-a", 41234)],
			issuers: [issuer("is-1", 6000)],
			mocks: [mock("mk-1", 5050, "Orders API")],
		});
		expect(servicesStoppedNotice(stopped)).toBe(
			'The inbox on port 41234, the mock server for "Orders API" on port 5050, and the mock OAuth issuer on port 6000 stopped when Vayu\'s engine restarted.'
		);
	});

	it("says it with one service as with three", () => {
		const stopped = runningServicesIn({ inboxes: [inbox("in-a", 41234)] });
		expect(servicesStoppedNotice(stopped)).toBe(
			"The inbox on port 41234 stopped when Vayu's engine restarted."
		);
	});

	it("counts what it does not name", () => {
		const stopped = runningServicesIn({
			inboxes: [1, 2, 3, 4, 5].map((n) => inbox(`in-${n}`, 41230 + n)),
		});
		expect(servicesStoppedNotice(stopped)).toBe(
			"The inbox on port 41231, the inbox on port 41232, the inbox on port 41233, and 2 more stopped when Vayu's engine restarted."
		);
	});
});

describe("the notice after an outage", () => {
	it("names two inboxes and a mock that were cached running and are gone", async () => {
		const client = new QueryClient();
		cacheServices(client, {
			inboxes: [inbox("in-a", 41234), inbox("in-b", 41235)],
			mocks: [mock("mk-1", 5050, "Orders API")],
		});
		recordServicesBeforeOutage(client);
		engineNowRuns({});

		await reportServicesStoppedByOutage(client);

		expect(notices()).toEqual([
			`The inbox on port 41234, the inbox on port 41235, and the mock server for "Orders API" on port 5050 stopped when Vayu's engine restarted.`,
		]);
		expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: "warning" }));
		// The fresh read is what the drawer shows next, not a second request.
		expect(client.getQueryData(queryKeys.inbox.list())).toEqual([]);
	});

	it("leaves out an inbox the engine still runs", async () => {
		const client = new QueryClient();
		cacheServices(client, {
			inboxes: [inbox("in-a", 41234), inbox("in-b", 41235)],
		});
		recordServicesBeforeOutage(client);
		engineNowRuns({ inboxes: [inbox("in-a", 41234)] });

		await reportServicesStoppedByOutage(client);

		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toContain("41235");
		expect(notices()[0]).not.toContain("41234");
	});

	it("says nothing when every service survived the outage", async () => {
		// A dropped poll or two against an engine that never went away.
		const client = new QueryClient();
		cacheServices(client, { issuers: [issuer("is-1", 6000)] });
		recordServicesBeforeOutage(client);
		engineNowRuns({ issuers: [issuer("is-1", 6000)] });

		await reportServicesStoppedByOutage(client);

		expect(showToast).not.toHaveBeenCalled();
	});

	it("says nothing when nothing was running", async () => {
		const client = new QueryClient();
		cacheServices(client, { inboxes: [inbox("in-a", 41234, false)], issuers: [], mocks: [] });
		recordServicesBeforeOutage(client);
		engineNowRuns({});

		await reportServicesStoppedByOutage(client);

		expect(showToast).not.toHaveBeenCalled();
		expect(listInboxes).not.toHaveBeenCalled();
	});

	it("says nothing without a recorded outage, whatever the lists did", async () => {
		// An MCP stop drains a list with the engine up the whole time.
		const client = new QueryClient();
		cacheServices(client, { inboxes: [inbox("in-a", 41234)] });
		engineNowRuns({});

		await reportServicesStoppedByOutage(client);

		expect(showToast).not.toHaveBeenCalled();
	});

	it("raises one notice for two reports of the same outage", async () => {
		// The health poll's reconnect and a manual restart both report.
		const client = new QueryClient();
		cacheServices(client, { inboxes: [inbox("in-a", 41234)] });
		recordServicesBeforeOutage(client);
		recordServicesBeforeOutage(client);
		engineNowRuns({});

		await Promise.all([
			reportServicesStoppedByOutage(client),
			reportServicesStoppedByOutage(client),
		]);

		expect(notices()).toHaveLength(1);
	});

	it("keeps the first record of an outage over a later one", async () => {
		const client = new QueryClient();
		cacheServices(client, { inboxes: [inbox("in-a", 41234)] });
		recordServicesBeforeOutage(client);
		// A list poll that reached the new engine first, before a later record.
		cacheServices(client, { inboxes: [] });
		recordServicesBeforeOutage(client);
		engineNowRuns({});

		await reportServicesStoppedByOutage(client);

		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toContain("41234");
	});

	it("raises nothing on a failed read, and compares again on the next reconnect", async () => {
		const client = new QueryClient();
		cacheServices(client, { inboxes: [inbox("in-a", 41234)] });
		recordServicesBeforeOutage(client);
		engineNowRuns({});
		listMockServers.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

		await reportServicesStoppedByOutage(client);
		expect(showToast).not.toHaveBeenCalled();

		// Mutation-check: drop the restore in the catch and this stays silent.
		await reportServicesStoppedByOutage(client);
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toContain("41234");
	});

	it("reads again when another refetch cancels the one it joined", async () => {
		// A second refetch of a list (a mutation's invalidate, the restart's)
		// cancels the fetch the report joined, and a joined read rejects on it.
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		cacheServices(client, { inboxes: [inbox("in-a", 41234)] });
		recordServicesBeforeOutage(client);
		engineNowRuns({});
		let answerFirstRead!: (inboxes: Inbox[]) => void;
		listInboxes.mockReturnValueOnce(
			new Promise<Inbox[]>((resolve) => {
				answerFirstRead = resolve;
			})
		);

		// The reconnect's invalidate starts the read, as the drawer's query would
		// (it carries the query function), and the report joins it.
		const reconnectRead = client.fetchQuery({
			queryKey: queryKeys.inbox.list(),
			queryFn: () => listInboxes(),
			staleTime: 0,
		});
		const report = reportServicesStoppedByOutage(client);
		expect(client.getQueryState(queryKeys.inbox.list())?.fetchStatus).toBe("fetching");
		const laterRefetch = client.refetchQueries({ queryKey: queryKeys.inbox.list() });
		answerFirstRead([inbox("in-a", 41234)]);
		await Promise.all([reconnectRead, report, laterRefetch]);

		// Mutation-check: rethrow a cancel in `fetchList` and nothing is named.
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toContain("41234");
	});

	it("replaces a snapshot a failed read put back with the next outage's own", async () => {
		const client = new QueryClient();
		cacheServices(client, { inboxes: [inbox("in-a", 41234)] });
		recordServicesBeforeOutage(client);
		engineNowRuns({});
		listMockServers.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
		await reportServicesStoppedByOutage(client);

		// The engine stayed up after all; the user stopped in-a and started in-b,
		// and only then did the next outage begin.
		cacheServices(client, { inboxes: [inbox("in-b", 41300)] });
		recordServicesBeforeOutage(client);
		await reportServicesStoppedByOutage(client);

		// Mutation-check: keep a restored snapshot over a new record and this
		// names 41234, a service this outage never saw.
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toContain("41300");
		expect(notices()[0]).not.toContain("41234");
	});

	it("drops a snapshot a failed read put back when nothing runs at the next outage", async () => {
		const client = new QueryClient();
		cacheServices(client, { inboxes: [inbox("in-a", 41234)] });
		recordServicesBeforeOutage(client);
		engineNowRuns({});
		listMockServers.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
		await reportServicesStoppedByOutage(client);

		cacheServices(client, { inboxes: [] });
		recordServicesBeforeOutage(client);
		await reportServicesStoppedByOutage(client);

		expect(showToast).not.toHaveBeenCalled();
	});

	it("records again once a notice has been raised", async () => {
		const client = new QueryClient();
		cacheServices(client, { inboxes: [inbox("in-a", 41234)] });
		recordServicesBeforeOutage(client);
		engineNowRuns({});
		await reportServicesStoppedByOutage(client);

		cacheServices(client, { inboxes: [inbox("in-b", 41300)] });
		recordServicesBeforeOutage(client);
		await reportServicesStoppedByOutage(client);

		expect(notices()).toHaveLength(2);
		expect(notices()[1]).toContain("41300");
	});

	it("opens Services from its action", async () => {
		const client = new QueryClient();
		cacheServices(client, { inboxes: [inbox("in-a", 41234)] });
		recordServicesBeforeOutage(client);
		engineNowRuns({});
		useLayoutStore.setState({ drawerView: "collections", drawerOpen: false });

		await reportServicesStoppedByOutage(client);
		const { action } = showToast.mock.calls[0][0] as { action: { onClick: () => void } };
		action.onClick();

		expect(useLayoutStore.getState()).toMatchObject({
			drawerView: "services",
			drawerOpen: true,
		});
	});
});
