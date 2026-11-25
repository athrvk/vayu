/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Compose and execute requests, and stop a load test, through the engine.

import { useState, useCallback } from "react";
import { ApiError, apiService } from "@/services";
import { approveEndpoint } from "@/lib/graphql/approved-endpoints";
import type {
	SanityResult,
	ExecuteRequestRequest,
	ComposeRequestRequest,
	ComposedRequest,
} from "@/types";

interface UseEngineReturn {
	/**
	 * Compose a request engine-side (`POST /compose`, #226): the raw editor state (plus scope ids)
	 * in, the execute-ready payload out, with `{{variables}}` and `inherit` auth resolved by the
	 * engine, exactly once. Throws on failure; callers surface it as they do an execute failure.
	 *
	 * Without `deferredVariables` (#2521): that answer is for display, and these callers spread the
	 * result into `/execute` and `/runs` bodies; the Code section reads it from
	 * `apiService.composeRequest` directly. The answer's `collectionId` stays (#3461): it is the
	 * scope the send's scripts read.
	 *
	 * Composing here is composing to send (Send, Load test and a History re-run are its only
	 * callers), so the answer's origin becomes an endpoint the GraphQL body may introspect on its
	 * own (`approved-endpoints.ts`). Anything that composes to display must use
	 * `apiService.composeRequest`.
	 */
	composeRequest: (params: ComposeRequestRequest) => Promise<ComposedRequest>;
	/**
	 * Execute a composed `ExecuteRequestRequest` (flat headers, resolved auth and body) against the
	 * engine. Resolves null once `signal` has aborted the send (#3352): a cancelled send has no
	 * answer, and a synthesised error response would show a failure nobody had.
	 */
	executeRequest: (
		params: ExecuteRequestRequest,
		environmentId?: string,
		signal?: AbortSignal
	) => Promise<SanityResult | null>;
	stopLoadTest: (runId: string) => Promise<boolean>;
	error: string | null;
}

export function useEngine(): UseEngineReturn {
	const [error, setError] = useState<string | null>(null);

	const composeRequest = useCallback(
		async (params: ComposeRequestRequest): Promise<ComposedRequest> => {
			const { deferredVariables: _deferredVariables, ...sendable } =
				await apiService.composeRequest(params);
			approveEndpoint(sendable.url);
			return sendable;
		},
		[]
	);

	const executeRequest = useCallback(
		async (
			params: ExecuteRequestRequest,
			environmentId?: string,
			signal?: AbortSignal
		): Promise<SanityResult | null> => {
			setError(null);

			try {
				const result = await apiService.executeRequest(
					{
						...params,
						environmentId: params.environmentId ?? environmentId,
					},
					signal
				);
				return result;
			} catch (err) {
				if (signal?.aborted) return null;
				const errorMessage =
					err instanceof Error ? err.message : "Couldn't connect to Vayu's engine.";
				const errorCode = err instanceof ApiError ? err.errorCode : "ENGINE_ERROR";

				setError(errorMessage);
				// The engine never answered, so the exchange half of `SanityResult`
				// (headers, body, timing) does not exist. `status: 0` is what marks
				// the result as synthesised; the cast says the same thing the shape
				// does, rather than inventing zeroed timings that read as measured.
				return {
					status: 0,
					statusText: "Error",
					error: errorMessage,
					errorCode: errorCode,
					errorMessage: errorMessage,
				} as unknown as SanityResult;
			}
		},
		[]
	);

	const stopLoadTest = useCallback(async (runId: string): Promise<boolean> => {
		setError(null);

		try {
			await apiService.stopRun(runId);
			return true;
		} catch (err) {
			const errorMessage =
				err instanceof Error
					? `Couldn't stop the load test - ${err.message}`
					: "Couldn't stop the load test.";
			setError(errorMessage);
			return false;
		}
	}, []);

	return {
		composeRequest,
		executeRequest,
		stopLoadTest,
		error,
	};
}
