
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * LoadTestDashboard Types
 *
 * Centralized type definitions for the load test dashboard
 */

import type { LoadTestMetrics, RunReport } from "@/types";

// ============================================================================
// Dashboard State Types
// ============================================================================

export type DashboardMode = "idle" | "running" | "completed" | "stopped";
export type DashboardView = "metrics" | "request-response";

// ============================================================================
// Component Props Types
// ============================================================================

export interface DashboardHeaderProps {
	runId: string;
	mode: DashboardMode;
	isStreaming: boolean;
	isStopping: boolean;
	onStop: () => Promise<void>;
}

export interface RunMetadataProps {
	requestUrl?: string;
	requestMethod?: string;
	startTime?: number;
	endTime?: number;
	mode: DashboardMode;
	elapsedDuration: number;
	setupOverhead?: number; // in seconds
	configuration?: {
		mode?: string;
		targetRps?: number;
		concurrency?: number;
		comment?: string;
	};
}

export interface MetricsViewProps {
	metrics: DisplayMetrics | null;
	historicalMetrics: LoadTestMetrics[];
	isCompleted: boolean;
}

export interface MetricCardProps {
	title: string;
	value: string | number;
	subtitle?: string;
	trend?: "up" | "down" | "neutral";
	color?: "default" | "success" | "warning" | "danger";
}

export interface RequestResponseViewProps {
	report: RunReport | null;
}

export interface LatencyChartProps {
	data: LoadTestMetrics[];
	isCompleted: boolean;
}

export interface ThroughputChartProps {
	data: LoadTestMetrics[];
	isCompleted: boolean;
}

// ============================================================================
// Derived Types
// ============================================================================

export interface DisplayMetrics {
	requests_completed: number;
	requests_failed: number;
	current_rps: number;
	latency_p50_ms: number;
	latency_p95_ms: number;
	latency_p99_ms: number;
	avg_latency_ms: number;
	bytes_sent: number;
	bytes_received: number;
	// Rate metrics (Open Model)
	send_rate?: number; // Rate at which requests are dispatched to the server
	throughput?: number; // Rate at which responses are received from the server
	// Connection metrics
	backpressure?: number; // Queue depth: requests sent but not yet responded
	current_concurrency?: number; // Number of concurrent HTTP connections
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes}m`;
}

/**
 * Format bytes to human-readable format
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Get HTTP method badge color class
 */
export function getMethodColor(method: string): string {
	switch (method.toUpperCase()) {
		case "GET":
			return "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300";
		case "POST":
			return "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300";
		case "PUT":
			return "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300";
		case "DELETE":
			return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
		case "PATCH":
			return "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300";
		default:
			return "bg-gray-100 text-gray-700 dark:bg-gray-950 dark:text-gray-300";
	}
}
