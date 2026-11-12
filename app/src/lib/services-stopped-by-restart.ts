/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The services an engine restart took with it (#3493).
 *
 * Every inbox, mock server and OAuth issuer is a listener inside the engine
 * process, so a crash or a restart stops all of them and the engine that comes
 * back answers the Services drawer with its first-run empty states. This keeps
 * what the cache said was running when the outage began, compares it with what
 * the engine reports once it is back, and raises one notice naming what is
 * gone.
 *
 * **The snapshot is taken when the outage begins, not at reconnect.** The
 * lists poll on their own (`SERVICES_POLL_INTERVAL_MS`), so by the time a
 * reconnect is noticed one of them may already hold the new engine's answer.
 * Only what the cache says is running counts: a stop the list has not shown
 * yet is named as if the restart had done it, which no read could tell apart.
 *
 * **One pending snapshot, module state rather than either caller's.** The
 * health poll's reconnect (`queries/health.ts`) and the manual restart
 * (`hooks/useEngineRestart.ts`) both record and both report, often for the same
 * outage. The first record of an outage wins, and the first report takes the
 * snapshot, so the second finds nothing and a single outage raises one notice.
 */

import type { QueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "@/queries/keys";
import { useToastStore } from "@/stores/toast-store";
import { useLayoutStore } from "@/stores/layout-store";
import { pickByCount } from "@/modules/dashboard/utils/format";
import { formatNumber } from "@/lib/format-number";
import type { Inbox, MockIssuer, MockServer } from "@/types";
import type { RunningServiceSummary } from "@/types/electron";

/** The three engine lists, as the cache or a fresh read holds them. */
export interface ServiceLists {
	inboxes?: Inbox[];
	issuers?: MockIssuer[];
	mocks?: MockServer[];
}

/** A running service plus the engine's id for it, which is what survives a port reuse. */
export interface RunningService extends RunningServiceSummary {
	id: string;
}

/** Beyond this many, the notice counts the rest instead of naming them. */
export const MAX_NAMED_STOPPED_SERVICES = 3;

/**
 * What is running, by the drawer's definition: an inbox keeps its record once
 * stopped and says so with `running`, while a stopped issuer or mock server is
 * gone from its list, so every one listed is running.
 */
export function runningServicesIn({
	inboxes = [],
	issuers = [],
	mocks = [],
}: ServiceLists): RunningService[] {
	return [
		...inboxes
			.filter((inbox) => inbox.running)
			.map((inbox) => ({
				kind: "inbox" as const,
				id: inbox.inboxId,
				name: null,
				port: inbox.port,
			})),
		...mocks.map((mock) => ({
			kind: "mock-server" as const,
			id: mock.mockId,
			// The name it was started under, which is how the drawer lists it.
			name: mock.collectionName,
			port: mock.port,
		})),
		...issuers.map((issuer) => ({
			kind: "issuer" as const,
			id: issuer.issuerId,
			name: null,
			port: issuer.port,
		})),
	];
}

const identity = (service: RunningService) => `${service.kind}:${service.id}`;

/**
 * What was running before and is not running now, compared by id and never by
 * port: the new engine can hand a fresh inbox the port a lost one held.
 */
export function servicesStopped(
	before: RunningService[],
	after: RunningService[]
): RunningService[] {
	const stillRunning = new Set(after.map(identity));
	return before.filter((service) => !stillRunning.has(identity(service)));
}

function describeService(service: RunningService): string {
	switch (service.kind) {
		case "inbox":
			return `the inbox on port ${service.port}`;
		case "issuer":
			return `the OAuth issuer on port ${service.port}`;
		case "mock-server":
			return service.name
				? `the mock server for '${service.name}' on port ${service.port}`
				: `the mock server on port ${service.port}`;
	}
}

/** "a", "a and b", "a, b, and c": the Oxford comma `docs/ux-writing.md` asks for. */
function joinPhrases(phrases: string[]): string {
	if (phrases.length <= 2) return phrases.join(" and ");
	return `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
}

/** The notice for a non-empty @p stopped. */
export function servicesStoppedNotice(stopped: RunningService[]): string {
	const named = stopped.slice(0, MAX_NAMED_STOPPED_SERVICES).map(describeService);
	const unnamed = stopped.length - named.length;
	const phrases = unnamed > 0 ? [...named, `${formatNumber(unnamed)} more`] : named;
	const list = joinPhrases(phrases);
	const pronoun = pickByCount(stopped.length, { one: "it", other: "them" });
	return `${list.charAt(0).toUpperCase()}${list.slice(1)} stopped when Vayu's engine restarted. Start ${pronoun} again from Services.`;
}

let runningWhenOutageBegan: RunningService[] | null = null;

/**
 * Keep what the cache says is running, at the first sign of an outage.
 *
 * A no-op while a snapshot is already pending: later in the same outage the
 * cache can only be as old or older, and after a reconnect that could not read
 * the lists the pending one is still the best record of what ran.
 */
export function recordServicesBeforeOutage(queryClient: QueryClient): void {
	if (runningWhenOutageBegan !== null) return;
	const running = runningServicesIn({
		inboxes: queryClient.getQueryData<Inbox[]>(queryKeys.inbox.list()),
		issuers: queryClient.getQueryData<MockIssuer[]>(queryKeys.mockIssuer.list()),
		mocks: queryClient.getQueryData<MockServer[]>(queryKeys.mockServer.list()),
	});
	if (running.length > 0) runningWhenOutageBegan = running;
}

/** The three lists from the engine now, written into the cache the drawer reads. */
async function fetchServiceLists(queryClient: QueryClient): Promise<ServiceLists> {
	const [inboxes, issuers, mocks] = await Promise.all([
		queryClient.fetchQuery({
			queryKey: queryKeys.inbox.list(),
			queryFn: () => apiService.listInboxes(),
			staleTime: 0,
		}),
		queryClient.fetchQuery({
			queryKey: queryKeys.mockIssuer.list(),
			queryFn: () => apiService.listMockIssuers(),
			staleTime: 0,
		}),
		queryClient.fetchQuery({
			queryKey: queryKeys.mockServer.list(),
			queryFn: () => apiService.listMockServers(),
			staleTime: 0,
		}),
	]);
	return { inboxes, issuers, mocks };
}

/**
 * On reconnect, name what the outage stopped, once.
 *
 * A read that fails raises nothing: not knowing what runs now is no evidence
 * that anything stopped. The snapshot then goes back for the next reconnect,
 * unless an outage that began meanwhile has already recorded its own.
 */
export async function reportServicesStoppedByOutage(queryClient: QueryClient): Promise<void> {
	const before = runningWhenOutageBegan;
	if (before === null) return;
	runningWhenOutageBegan = null;

	let after: RunningService[];
	try {
		after = runningServicesIn(await fetchServiceLists(queryClient));
	} catch {
		if (runningWhenOutageBegan === null) runningWhenOutageBegan = before;
		return;
	}

	const stopped = servicesStopped(before, after);
	if (stopped.length === 0) return;
	useToastStore.getState().showToast({
		message: servicesStoppedNotice(stopped),
		variant: "warning",
		action: {
			label: "View services",
			altText: "Open Services in the sidebar",
			onClick: () => useLayoutStore.getState().revealDrawerView("services"),
		},
	});
}

export function resetServicesBeforeOutageForTests(): void {
	runningWhenOutageBegan = null;
}
