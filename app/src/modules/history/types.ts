
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * History Component Types
 */

import type { RunReport } from "@/types";

export interface TabProps {
	report: RunReport;
	runId?: string;
}

export interface DesignRunDetailProps {
	report: RunReport;
	onBack: () => void;
	runId: string;
}

export interface LoadTestDetailProps {
	report: RunReport;
	onBack: () => void;
	runId: string;
}

export interface SampleResult {
	timestamp: number;
	statusCode: number;
	latencyMs: number;
	error?: string;
	trace?: {
		dnsMs?: number;
		connectMs?: number;
		tlsMs?: number;
		firstByteMs?: number;
		downloadMs?: number;
		request?: {
			method?: string;
			url?: string;
			headers?: Record<string, string>;
			body?: string;
		};
		response?: {
			headers?: Record<string, string>;
			body?: any;
		};
	};
}
