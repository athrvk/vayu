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
 * Which identity the run copy files its per-builder memory under (issue #1272).
 *
 * The copy is id-less on purpose - `seedFromRun` sets `id: null`, one of the
 * two gates that stop an edited copy from rewriting the saved request - so the
 * provider cannot derive an identity for it and is told one. What the provider
 * does with that identity is asserted through the real thing in
 * `request-builder/context/auto-records-per-request.test.tsx`; what one line of
 * JSX cannot say for itself is that this view still passes it, which is the
 * whole of the fix on this side.
 *
 * In a file of its own because it stubs the provider out, and the rest of
 * `DesignRunView.test.tsx` needs the real one; the Cancel case below shares the
 * stub for the same reason.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@/test/render-with-tooltips";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DesignRunView from "./DesignRunView";
import { queryKeys } from "@/queries/keys";
import type { Run } from "@/types";

const executeRequest = vi.fn();
const composeRequest = vi.fn();
vi.mock("@/hooks/useEngine", () => ({
	useEngine: () => ({ executeRequest, composeRequest }),
}));

vi.mock("@/queries", async () => {
	const actual = await vi.importActual<typeof import("@/queries")>("@/queries");
	return {
		...actual,
		// Settled, request deleted: the orphan seed, which is the shortest path
		// to a mounted provider. The identity asked about is the run's either way.
		useRequestQuery: () => ({
			data: undefined,
			isLoading: false,
			isError: false,
			error: null,
			refetch: vi.fn(),
		}),
		useCollectionAncestors: () => [],
	};
});

/** The props the view mounted the provider with, captured rather than rendered. */
let providerProps: Record<string, unknown> = {};

vi.mock("@/modules/request-builder/context", async () => {
	const actual = await vi.importActual<typeof import("@/modules/request-builder/context")>(
		"@/modules/request-builder/context"
	);
	return {
		...actual,
		// Children dropped: the builder's layout has nothing to say here, and
		// rendering it would need the real context this stub is replacing.
		RequestBuilderProvider: (props: Record<string, unknown>) => {
			providerProps = props;
			return null;
		},
	};
});

const run = {
	id: "run_42",
	type: "design",
	status: "completed",
	startTime: 1_750_000_000_000,
	endTime: 1_750_000_000_300,
	requestId: null,
	environmentId: null,
	configSnapshot: { method: "GET", url: "https://api.example.test/" },
	result: { timestamp: 1_750_000_000_000, statusCode: 200, statusText: "OK", latencyMs: 12 },
} as unknown as Run;

function renderView() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<DesignRunView run={run} />
		</QueryClientProvider>
	);
	return client;
}

describe("DesignRunView - the copy declares which run it is", () => {
	it("files the builder's memory under the run id, not under the copy's null id", () => {
		renderView();

		expect(providerProps.memoryKey).toBe("run_42");
		// And the id stays null: the identity is declared beside it, never as it.
		expect((providerProps.initialRequest as { id: string | null }).id).toBeNull();
	});
});

/** The copy's Send has the builder's Cancel too, so the signal must reach the engine call (#3352). */
describe("DesignRunView - the copy's send can be cancelled", () => {
	it("hands the provider's signal to the engine's execute", async () => {
		composeRequest.mockResolvedValue({ method: "GET", url: "https://api.example.test/" });
		executeRequest.mockResolvedValue(null);
		renderView();
		const cancel = new AbortController();

		await (
			providerProps.onExecute as (
				r: unknown,
				dataRow: undefined,
				signal: AbortSignal
			) => Promise<unknown>
		)(providerProps.initialRequest, undefined, cancel.signal);

		expect(executeRequest).toHaveBeenCalledTimes(1);
		expect(executeRequest.mock.calls[0][2]).toBe(cancel.signal);
	});

	it("still tells History about the run, because the engine records it", async () => {
		composeRequest.mockResolvedValue({ method: "GET", url: "https://api.example.test/" });
		executeRequest.mockResolvedValue(null);
		const client = renderView();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await (
			providerProps.onExecute as (
				r: unknown,
				dataRow: undefined,
				signal: AbortSignal
			) => Promise<unknown>
		)(providerProps.initialRequest, undefined, new AbortController().signal);

		// Mutation check: put the `if (!result) return null` exit back above
		// the invalidations and a cancelled replay leaves History stale.
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.lists() });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.count() });
	});
});
