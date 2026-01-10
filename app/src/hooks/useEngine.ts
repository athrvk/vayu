// useEngine Hook - Execute requests and manage load tests

import { useState, useCallback } from "react";
import { apiService } from "@/services";
import type {
	SanityResult,
	StartLoadTestRequest,
	StartLoadTestResponse,
	LoadTestConfig,
	Request,
} from "@/types";

interface UseEngineReturn {
	executeRequest: (
		request: Request,
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
			request: Request,
			environmentId?: string
		): Promise<SanityResult | null> => {
			setIsExecuting(true);
			setError(null);

			try {
				// Build the request body according to API documentation
				const result = await apiService.executeRequest({
					method: request.method,
					url: request.url,
					headers: request.headers,
					body: request.body
						? request.body_type === "json"
							? JSON.parse(request.body)
							: request.body
						: undefined,
					auth: request.auth,
					preRequestScript: request.pre_request_script,
					postRequestScript: request.test_script,
					requestId: request.id,
					environmentId: environmentId,
				});
				return result;
			} catch (err) {
				// Import ApiError for type checking
				if (err && typeof err === 'object' && 'userFriendlyMessage' in err) {
					const apiError = err as any;
					setError(apiError.userFriendlyMessage);

					// Return structured error response for UI to display
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
				const payload: StartLoadTestRequest = {
					// The HTTP request configuration
					request: {
						method: request.method,
						url: request.url,
						headers: request.headers,
						body: request.body
							? request.body_type === "json"
								? JSON.parse(request.body)
								: request.body
							: undefined,
					},
					// Load test strategy
					mode: config.mode === "constant_rps" || config.mode === "constant_concurrency"
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
			const errorMessage =
				err instanceof Error ? err.message : "Failed to stop load test";
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
