/**
 * History Component Types
 */

import type { RunReport } from "@/types";

export interface TabProps {
	report: RunReport;
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
