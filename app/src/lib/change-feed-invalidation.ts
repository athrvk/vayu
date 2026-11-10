/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The engine's change feed (`GET /changes`, issue #3420), mapped onto the cache.
 *
 * Each event becomes the MCP data families of `lib/mcp-invalidation.ts`, so the
 * feed and the in-app MCP channel invalidate through one key table; this module
 * adds only what the families cannot say. A feed event carries the operation,
 * which an MCP event does not, and that is what splits a collection's row write
 * from its cascade. A client certificate's trash write is the one event no
 * family covers on its own (the MCP tools that touch one declare `collection`
 * beside it), so its trash refetch is named here.
 *
 * `FeedInvalidationBatch` is the coalescing in front of that: the feed reports
 * every write, the app's own autosave included, so a burst becomes one
 * invalidation per key, applied once no mutation of this window is in flight.
 */

import type { QueryClient } from "@tanstack/react-query";
import { invalidateForMcpEvent } from "@/lib/mcp-invalidation";
import { ownerOfRequest } from "@/queries/collections";
import { invalidateCompositions } from "@/queries/compose-invalidation";
import { queryKeys } from "@/queries/keys";
import type { McpDataChangedEvent, McpDataEntity, Request } from "@/types";

/** The row kinds this build knows how to invalidate. */
export type ChangeFeedKind =
	"collection" | "request" | "example" | "environment" | "globals" | "clientCertificate";

/**
 * One `change` frame's data. `kind` and `op` stay plain strings: an engine
 * newer than this bundle can name either one this build has never heard of,
 * and the frame must still parse so its id still advances the resume point.
 */
export interface ChangeFeedChange {
	kind: string;
	id: string;
	op: string;
	/** A request's collection, a sub-folder's parent. */
	collectionId?: string;
	/** An example's request. */
	requestId?: string;
}

/** What one change asks of the cache. */
export interface FeedInvalidation {
	families: McpDataChangedEvent[];
	/** The Trash list, for a change none of `families` already refetches it for. */
	trash?: boolean;
}

/** Narrow one `change` frame's data, or reject it. */
export function parseChangeFeedChange(raw: unknown): ChangeFeedChange | null {
	if (typeof raw !== "object" || raw === null) return null;
	const e = raw as Record<string, unknown>;
	if (typeof e.kind !== "string" || typeof e.id !== "string" || typeof e.op !== "string") {
		return null;
	}
	return {
		kind: e.kind,
		id: e.id,
		op: e.op,
		...(typeof e.collectionId === "string" ? { collectionId: e.collectionId } : {}),
		...(typeof e.requestId === "string" ? { requestId: e.requestId } : {}),
	};
}

/**
 * The ops that write one collection row and nothing beneath it. Every other op
 * on a collection, an unknown one included, takes the cascade: a delete,
 * restore or purge is one event on the root for the whole subtree.
 */
const ROW_WRITES: ReadonlySet<string> = new Set(["create", "update"]);

/** Where the cache last saw @p requestId: its own detail entry, then the tree's lists. */
function cachedOwner(queryClient: QueryClient, requestId: string): string | undefined {
	return (
		queryClient.getQueryData<Request>(queryKeys.requests.detail(requestId))?.collectionId ??
		ownerOfRequest(queryClient, requestId)
	);
}

/**
 * The `request` family for @p requestId, once per collection whose list can
 * have changed. A move's event names only the destination, so the owner the
 * cache still holds is the source; an owner the cache never saw is in no list
 * on screen. With neither known the family falls back to every list.
 */
function requestFamilies(
	queryClient: QueryClient,
	requestId: string,
	collectionId: string | undefined
): McpDataChangedEvent[] {
	const previous = cachedOwner(queryClient, requestId);
	const owners = new Set([collectionId ?? previous]);
	if (previous) owners.add(previous);
	return [...owners].map((owner) => ({ entity: "request", requestId, collectionId: owner }));
}

/**
 * Which caches each kind invalidates. A `Record` over the union, as
 * `INVALIDATORS` is over the MCP families: a kind added to `ChangeFeedKind`
 * fails to compile until it names a reader here.
 */
const BY_KIND: Record<
	ChangeFeedKind,
	(queryClient: QueryClient, change: ChangeFeedChange) => FeedInvalidation
> = {
	collection: (_queryClient, change) => ({
		families: [{ entity: ROW_WRITES.has(change.op) ? "collectionRow" : "collection" }],
	}),
	request: (queryClient, change) => ({
		families: requestFamilies(queryClient, change.id, change.collectionId),
	}),
	/*
	 * The `request` family named by the example's request, as the MCP example
	 * tools declare it: the Examples list sits under that request's detail key,
	 * and the family takes the Trash list a saved example's delete adds to.
	 */
	example: (queryClient, change) => ({
		families: change.requestId ? requestFamilies(queryClient, change.requestId, undefined) : [],
	}),
	environment: () => ({ families: [{ entity: "environment" }] }),
	// Globals ride on the environment family (#758), as `update_globals` does.
	globals: () => ({ families: [{ entity: "environment" }] }),
	// The feed carries only a certificate's delete, restore and purge.
	clientCertificate: () => ({ families: [{ entity: "clientCertificate" }], trash: true }),
};

/** Own keys only: `"constructor"` from a newer engine must not reach `Object`'s. */
function isChangeFeedKind(kind: string): kind is ChangeFeedKind {
	return Object.prototype.hasOwnProperty.call(BY_KIND, kind);
}

/**
 * What @p change asks of the cache, or `null` for a kind this build does not
 * know. Read when the event arrives, not when the batch flushes: a request
 * move's source is the owner the cache holds before anything refetches it.
 */
export function invalidationsForChange(
	queryClient: QueryClient,
	change: ChangeFeedChange
): FeedInvalidation | null {
	if (!isChangeFeedKind(change.kind)) return null;
	return BY_KIND[change.kind](queryClient, change);
}

/**
 * The families that together cover every row the feed describes: collections
 * and everything under them, environments and the globals, the certificate
 * registry, the Trash list and every composition. What a `reset` asks for.
 */
const FEED_DOMAIN: readonly McpDataEntity[] = ["collection", "environment", "clientCertificate"];

/** Treat every row the feed describes as stale. */
export function invalidateFeedDomain(queryClient: QueryClient): void {
	for (const entity of FEED_DOMAIN) invalidateForMcpEvent(queryClient, { entity });
}

/**
 * Re-read what the open tabs show of the feed's rows, and nothing wider: what a
 * fresh subscription's `ready` asks for.
 *
 * The app's first reads go out as the window paints and the stream opens once
 * the engine answers, so a write another client commits between the two is
 * never reported. The request detail and the compositions are `staleTime:
 * Infinity`, so a restored tab would keep the version it read and Send would
 * send it; the collections, environments and globals lists are what an open
 * collection or environment tab reads, and nothing refetches a mounted one.
 * Each is one call, and only a read some surface is observing is refetched -
 * the rest are marked stale for their next mount. Not the request lists: the
 * workspace-wide `GET /requests` is the launch's heaviest call, and the tree
 * reads a name and a method from it, never what Send sends.
 */
export function invalidateOpenRows(queryClient: QueryClient): void {
	void queryClient.invalidateQueries({ queryKey: queryKeys.requests.details() });
	invalidateCompositions(queryClient);
	void queryClient.invalidateQueries({ queryKey: queryKeys.collections.lists() });
	void queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
	void queryClient.invalidateQueries({ queryKey: queryKeys.globals.all });
}

/**
 * How long the first event of a burst waits for the rest.
 *
 * Four of the engine's 50ms relay polls (`RELAY_POLL_INTERVAL_MS`): a bulk
 * write publishes its rows together after one commit, so they reach the
 * stream within a poll or two and land in one flush, while an edit made
 * elsewhere still reaches the open app within a fifth of a second. The window
 * is fixed from the first event rather than restarted by each one, so a client
 * that writes without pause still has its changes shown every 200ms.
 */
export const CHANGE_FEED_COALESCE_MS = 200;

/**
 * The longest a flush waits on in-flight mutations before it lands anyway.
 *
 * The writes the hold is for - an autosave PUT, a drop's `POST /reorder` - are
 * one local round trip, tens of milliseconds. A mutation that is still pending
 * after this long is not one of them but a hung or long write (an import, a
 * spec sync, an OAuth sign-in), and every change any other client made, a
 * `reset` included, would otherwise wait for it.
 */
export const CHANGE_FEED_MUTATION_HOLD_MAX_MS = 5_000;

/** One key per family and scope, so a burst on one row is one invalidation. */
function familyKey(event: McpDataChangedEvent): string {
	return `${event.entity}|${event.collectionId ?? ""}|${event.requestId ?? ""}`;
}

/**
 * Coalesces the feed's invalidations and applies them outside any mutation.
 *
 * A flush waits while a mutation is in flight because the feed reports the
 * app's own writes too, and protects two things by it. The autosave PUT's echo
 * refetches after the PUT's own answer has been stored, and reads the row it
 * wrote. A write by someone else arriving mid-reorder cannot refetch the lists
 * from under the drop's optimistic draw, which `useReorderMutation` cancelled
 * the in-flight reads to protect. The wait is bounded by
 * {@link CHANGE_FEED_MUTATION_HOLD_MAX_MS}, past which neither write is the
 * one in flight.
 */
export class FeedInvalidationBatch {
	private families = new Map<string, McpDataChangedEvent>();
	private trash = false;
	private reset = false;
	private openRows = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** Waiting on in-flight mutations; what arrives meanwhile joins the held flush. */
	private holding = false;

	constructor(readonly queryClient: QueryClient) {}

	add(invalidation: FeedInvalidation): void {
		for (const event of invalidation.families) this.families.set(familyKey(event), event);
		if (invalidation.trash) this.trash = true;
		this.arm();
	}

	/** What the open tabs show may be stale (see {@link invalidateOpenRows}). */
	addOpenRows(): void {
		this.openRows = true;
		this.arm();
	}

	/** Everything the feed describes is stale; this subsumes whatever is pending. */
	addReset(): void {
		this.reset = true;
		this.arm();
	}

	private arm(): void {
		// A batch already timed, or waiting on a mutation, takes this change with it.
		if (this.timer !== null || this.holding) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, CHANGE_FEED_COALESCE_MS);
	}

	/** @p force: the hold's bound has passed, so flush whatever is mutating. */
	private flush(force = false): void {
		if (!force && this.queryClient.isMutating() > 0) {
			this.flushWhenMutationsSettle();
			return;
		}
		const { families, trash, reset, openRows } = this;
		this.families = new Map();
		this.trash = false;
		this.reset = false;
		this.openRows = false;
		if (reset) {
			invalidateFeedDomain(this.queryClient);
			return;
		}
		if (openRows) invalidateOpenRows(this.queryClient);
		for (const event of families.values()) invalidateForMcpEvent(this.queryClient, event);
		if (trash) void this.queryClient.invalidateQueries({ queryKey: queryKeys.trash.all });
	}

	/**
	 * Flush once nothing is mutating, or once the hold's bound has passed. A
	 * mutation reaches the cache's `success` state only after its `onSuccess`
	 * and `onSettled` have run, so the flush follows the mutation's own cache
	 * writes.
	 */
	private flushWhenMutationsSettle(): void {
		const done = (force: boolean) => {
			unsubscribe();
			clearTimeout(bound);
			this.holding = false;
			this.flush(force);
		};
		const unsubscribe = this.queryClient.getMutationCache().subscribe(() => {
			if (this.queryClient.isMutating() === 0) done(false);
		});
		const bound = setTimeout(() => done(true), CHANGE_FEED_MUTATION_HOLD_MAX_MS);
		this.holding = true;
	}
}
