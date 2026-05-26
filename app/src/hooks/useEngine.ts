
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// useEngine Hook - Execute requests and manage load tests

import { useState, useCallback } from "react";
import { ApiError, apiService } from "@/services";
import type {
	SanityResult,
	ExecuteRequestRequest,
} from "@/types";

interface UseEngineReturn {
	/**
	 * Execute a request against the engine.
	 * Accepts a pre-resolved ExecuteRequestRequest (flat headers, resolved auth/body).
	 */
	executeRequest: (
		params: ExecuteRequestRequest,
		environmentId?: string
	) => Promise<SanityResult | null>;
	stopLoadTest: (runId: string) => Promise<boolean>;
	isExecuting: boolean;
	error: string | null;
}

export function useEngine(): UseEngineReturn {
	const [isExecuting, setIsExecuting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const executeRequest = useCallback(
		async (
			params: ExecuteRequestRequest,
			environmentId?: string
		): Promise<SanityResult | null> => {
			setIsExecuting(true);
			setError(null);

			try {
				const result = await apiService.executeRequest({
					...params,
					environmentId: params.environmentId ?? environmentId,
				});
				return result;
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Failed to connect to engine";
				const errorCode = err instanceof ApiError ? err.errorCode : "ENGINE_ERROR";

				setError(errorMessage);
				return {
					status: 0,
					statusText: "Error",
					error: errorMessage,
					errorCode: errorCode,
					errorMessage: errorMessage,
				} as any;
			} finally {
				setIsExecuting(false);
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
			const errorMessage = err instanceof Error ? err.message : "Failed to stop load test";
			setError(errorMessage);
			return false;
		}
	}, []);

	return {
		executeRequest,
		stopLoadTest,
		isExecuting,
		error,
	};
}
