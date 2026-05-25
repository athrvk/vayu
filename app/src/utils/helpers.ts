
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { LoadTestConfig } from "@/types";

// Utility Functions

/**
 * Format date to relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(timestamp: string | number): string {
	const date = new Date(timestamp);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();

	const seconds = Math.floor(diffMs / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (seconds < 60) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;

	return date.toLocaleString();
}

/**
 * Format number with thousand separators
 */
export function formatNumber(num: number | undefined | null): string {
	if (num === undefined || num === null || isNaN(num)) return "0";
	return num.toLocaleString();
}

/**
 * Format percentage
 */
export function formatPercent(value: number, total: number): string {
	if (total === 0) return "0%";
	return `${((value / total) * 100).toFixed(1)}%`;
}

/**
 * Get HTTP method color class
 */
/**
 * Returns the CSS variable reference for an HTTP method's color token.
 * Use as: `hsl(${getMethodColor(method)})` for a solid color,
 *      or `hsl(${getMethodColor(method)} / 0.1)` for a tinted background.
 */
export function getMethodColor(method: string): string {
	const m = method.toLowerCase();
	const known = ["get", "post", "put", "patch", "delete", "head", "options"];
	return known.includes(m) ? `var(--method-${m})` : "var(--method-options)";
}

export function loadTestTypeToLabel(type: LoadTestConfig["mode"] | string): string {
	switch (type) {
		case "constant_rps":
			return "Constant RPS";
		case "constant_concurrency":
			return "Constant Concurrency";
		case "iterations":
			return "Iterations";
		case "ramp_up":
			return "Ramp Up";
		default:
			return type;
	}
}
