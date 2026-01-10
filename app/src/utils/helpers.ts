// Utility Functions

import { type ClassValue, clsx } from "clsx";

/**
 * Merge class names with clsx
 */
export function cn(...inputs: ClassValue[]) {
	return clsx(inputs);
}

/**
 * Format bytes to human-readable format
 */
export function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";

	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));

	return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Format milliseconds to human-readable format
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
	if (ms < 3600000)
		return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
	return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

/**
 * Format timestamp to local date/time string
 */
export function formatTimestamp(timestamp: string | number): string {
	const date = new Date(timestamp);
	return date.toLocaleString();
}

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

	return formatTimestamp(timestamp);
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
 * Truncate string with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
	if (str.length <= maxLength) return str;
	return str.slice(0, maxLength - 3) + "...";
}

/**
 * Parse JSON safely
 */
export function safeParseJSON(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

/**
 * Stringify JSON with formatting
 */
export function formatJSON(data: unknown): string {
	try {
		return JSON.stringify(data, null, 2);
	} catch {
		return String(data);
	}
}

/**
 * Get HTTP status color class
 */
export function getStatusColor(status: number): string {
	if (status >= 200 && status < 300) return "text-green-600";
	if (status >= 300 && status < 400) return "text-blue-600";
	if (status >= 400 && status < 500) return "text-yellow-600";
	return "text-red-600";
}

/**
 * Get HTTP method color class
 */
export function getMethodColor(method: string): string {
	const colors: Record<string, string> = {
		GET: "text-blue-600 bg-blue-50",
		POST: "text-green-600 bg-green-50",
		PUT: "text-yellow-600 bg-yellow-50",
		PATCH: "text-purple-600 bg-purple-50",
		DELETE: "text-red-600 bg-red-50",
		HEAD: "text-gray-600 bg-gray-50",
		OPTIONS: "text-gray-600 bg-gray-50",
	};
	return colors[method.toUpperCase()] || "text-gray-600 bg-gray-50";
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
	func: T,
	wait: number
): (...args: Parameters<T>) => void {
	let timeout: NodeJS.Timeout | null = null;

	return (...args: Parameters<T>) => {
		if (timeout) clearTimeout(timeout);
		timeout = setTimeout(() => func(...args), wait);
	};
}

/**
 * Generate unique ID
 */
export function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
