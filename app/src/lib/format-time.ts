/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** A wall-clock time (e.g. "2:14:03 PM") for a list row, from epoch milliseconds. */
export function formatTime(ms: number): string {
	return new Date(ms).toLocaleTimeString();
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

	return date.toLocaleString();
}
