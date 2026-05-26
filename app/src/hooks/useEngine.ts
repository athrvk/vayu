
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
	StartLoadTestRequest,
	StartLoadTestResponse,
	LoadTestConfig,
	Request,
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
	startLoadTest: (
		request: Request,
		config: LoadTestConfig,
		environmentId?: string
	) => Promise<StartLoadTestResponse | null>;
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

	const startLoadTest = useCallback(
		async (
			request: Request,
			config: LoadTestConfig,
			environmentId?: string
		): Promise<StartLoadTestResponse | null> => {
			setIsExecuting(true);
			setError(null);

			try {
				const payload: StartLoadTestRequest = {
					method: request.method,
					url: request.url,
					// Flat headers passed in from caller (already resolved)
					headers: {},
					mode: config.mode,
					duration: config.duration_seconds ? `${config.duration_seconds}s` : undefined,
					targetRps: config.rps,
					iterations: config.iterations,
					concurrency: config.concurrency,
					rampUpDuration: config.ramp_duration_seconds
						? `${config.ramp_duration_seconds}s`
						: undefined,
					requestId: request.id,
					environmentId: environmentId,
					success_sample_rate: config.data_sample_rate,
					slow_threshold_ms: config.slow_threshold_ms,
					save_timing_breakdown: config.save_timing_breakdown,
					comment: config.comment,
				};

				const response = await apiService.startLoadTest(payload);
				return response;
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Failed to start load test";
				setError(errorMessage);
				return null;
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
		startLoadTest,
		stopLoadTest,
		isExecuting,
		error,
	};
}
