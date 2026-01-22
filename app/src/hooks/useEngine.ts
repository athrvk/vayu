
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
	StartLoadTestRequest,
	StartLoadTestResponse,
	LoadTestConfig,
	Request,
} from "@/types";

interface UseEngineReturn {
	executeRequest: (request: Request, environmentId?: string) => Promise<SanityResult | null>;
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
		async (request: Request, environmentId?: string): Promise<SanityResult | null> => {
			setIsExecuting(true);
			setError(null);

			try {
				// Build the request body according to API documentation
				// Backend expects body as { mode: string, content: string }
				const bodyPayload = request.body
					? {
							mode: request.bodyType || "text",
							content: request.body,
						}
					: undefined;

				const result = await apiService.executeRequest({
					method: request.method,
					url: request.url,
					headers: request.headers,
					body: bodyPayload,
					auth: request.auth,
					preRequestScript: request.preRequestScript,
					postRequestScript: request.postRequestScript,
					requestId: request.id,
					environmentId: environmentId,
				});
				return result;
			} catch (err) {
				// Only handle true engine API failures (network errors, engine down, invalid request format)
				// All valid request executions now return HTTP 200 with Response object
				if (err && typeof err === "object" && "userFriendlyMessage" in err) {
					const apiError = err as ApiError;
					setError(apiError.userFriendlyMessage);

					// Return minimal error structure only for engine API failures
					return {
						error: apiError.userFriendlyMessage,
						errorCode: apiError.errorCode,
						statusCode: apiError.statusCode,
					} as any;
				}
				const errorMessage =
					err instanceof Error ? err.message : "Failed to execute request";
				setError(errorMessage);
				return {
					error: errorMessage,
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
				// Build payload matching backend POST /run expectations
				// Backend expects body as { mode: string, content: string }
				const bodyPayload = request.body
					? {
							mode: request.bodyType || "text",
							content: request.body,
						}
					: undefined;

				const payload: StartLoadTestRequest = {
					// The HTTP request configuration
					request: {
						method: request.method,
						url: request.url,
						headers: request.headers,
						body: bodyPayload,
					},
					// Load test strategy
					mode:
						config.mode === "constant_rps" || config.mode === "constant_concurrency"
							? "constant"
							: config.mode === "iterations"
								? "iterations"
								: "ramp_up",
					// Duration (convert seconds to string format)
					duration: config.duration_seconds ? `${config.duration_seconds}s` : undefined,
					targetRps: config.rps,
					iterations: config.iterations,
					concurrency: config.concurrency,
					// Ramp-up settings
					rampUpDuration: config.ramp_duration_seconds
						? `${config.ramp_duration_seconds}s`
						: undefined,
					// Linking
					requestId: request.id,
					environmentId: environmentId,
					// Data capture options
					success_sample_rate: config.data_sample_rate,
					slow_threshold_ms: config.slow_threshold_ms,
					save_timing_breakdown: config.save_timing_breakdown,
					// Metadata
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
