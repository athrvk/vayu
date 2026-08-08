/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi, afterEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateForMcpEvent } from "./mcp-invalidation";
import { queryKeys } from "@/queries/keys";
import type { McpDataChangedEvent } from "@/types/domain";

/** Apply one event against a spied client and return the keys it invalidated. */
function keysFor(event: McpDataChangedEvent) {
	const queryClient = new QueryClient();
	const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
	const handled = invalidateForMcpEvent(queryClient, event);
	return { handled, keys: spy.mock.calls.map(([filters]) => filters?.queryKey) };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("invalidateForMcpEvent", () => {
	test("a created request invalidates only its own collection's list", () => {
		const { handled, keys } = keysFor({ entity: "request", collectionId: "col_1" });
		expect(handled).toBe(true);
		expect(keys).toEqual([queryKeys.requests.listByCollection("col_1")]);
	});

	test("a request change with no named collection invalidates every list", () => {
		// The owner is unknowable from here, and a per-collection key would leave
		// whichever list actually changed stale.
		const { keys } = keysFor({ entity: "request" });
		expect(keys).toEqual([queryKeys.requests.lists()]);
	});

	test("an updated request also drops its detail cache", () => {
		// `requestDetailOptions` is `staleTime: Infinity`, so a restored tab would
		// otherwise keep serving the copy it read when it opened.
		const { keys } = keysFor({ entity: "request", requestId: "req_3" });
		expect(keys).toContainEqual(queryKeys.requests.detail("req_3"));
	});

	test("a created request touches no detail cache", () => {
		// A create names no request id, and the row it made has no detail entry to
		// invalidate - the narrowing exists for the tools that name one row.
		const { keys } = keysFor({ entity: "request", collectionId: "col_1" });
		expect(keys).toEqual([queryKeys.requests.listByCollection("col_1")]);
	});

	test("a collection change invalidates collections and every request family", () => {
		// A cascade delete takes descendants and their requests with it, and which
		// rows those were is engine-side knowledge - so both families go wholesale.
		const { keys } = keysFor({ entity: "collection" });
		expect(keys).toEqual([queryKeys.collections.all, queryKeys.requests.all]);
	});

	test("an environment change invalidates the list and the details", () => {
		const { keys } = keysFor({ entity: "environment" });
		expect(keys).toContainEqual(queryKeys.environments.all);
	});

	test("an environment change also drops every composed request", () => {
		// `POST /compose` substitutes environment variables, so an MCP write to
		// them leaves every cached composition - and the curl/fetch snippet the
		// context bar builds from one - describing the pre-write values. Compose is
		// never refetched on its own, so without this the snippet stays wrong until
		// the tab is reopened.
		const { keys } = keysFor({ entity: "environment" });
		expect(keys).toContainEqual(queryKeys.compose.all);
	});

	test("a run invalidates both list families", () => {
		const { keys } = keysFor({ entity: "run" });
		expect(keys).toEqual([queryKeys.runs.lists(), queryKeys.runs.allRuns()]);
	});

	test("a run linked to a saved request also invalidates its last design run", () => {
		const { keys } = keysFor({ entity: "run", requestId: "req_7" });
		expect(keys).toContainEqual(queryKeys.runs.lastDesign("req_7"));
	});

	test("a run leaves per-run reports alone", () => {
		// A new run cannot have changed an existing run's report, and those are
		// the expensive fetches in this family.
		const { keys } = keysFor({ entity: "run", requestId: "req_7" });
		expect(keys).not.toContainEqual(queryKeys.runs.report("req_7"));
		expect(keys).not.toContainEqual(queryKeys.runs.all);
	});

	test("a cookie change invalidates the single jar key", () => {
		const { keys } = keysFor({ entity: "cookie" });
		expect(keys).toEqual([queryKeys.cookies.all]);
	});

	test("a config change invalidates the config query", () => {
		const { keys } = keysFor({ entity: "config" });
		expect(keys).toEqual([queryKeys.config.all]);
	});

	test("an unknown entity is reported, not thrown", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { handled, keys } = keysFor({
			entity: "sasquatch",
		} as unknown as McpDataChangedEvent);
		expect(handled).toBe(false);
		expect(keys).toEqual([]);
		expect(warn).toHaveBeenCalled();
	});
});
