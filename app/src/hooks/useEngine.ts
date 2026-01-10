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
		requestId: string,
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
				const errorMessage =
					err instanceof Error ? err.message : "Failed to execute request";
				setError(errorMessage);
				return null;
			} finally {
				setIsExecuting(false);
			}
		},
		[]
	);

	const startLoadTest = useCallback(
		async (
			requestId: string,
			config: LoadTestConfig,
			environmentId?: string
		): Promise<StartLoadTestResponse | null> => {
			setIsExecuting(true);
			setError(null);

			try {
				const request: StartLoadTestRequest = {
					request_id: requestId,
					environment_id: environmentId,
					config,
				};
				const response = await apiService.startLoadTest(request);
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
