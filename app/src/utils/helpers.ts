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
