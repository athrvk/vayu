
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Size Formatting Utilities
 *
 * Converts between bytes and human-readable formats (KB, MB, GB)
 * for display and input in settings.
 */

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Parse human-readable size string to bytes
 * Supports formats like: "64 MB", "1.5GB", "1024KB", "500 B", "256" (bytes)
 */
export function parseSizeToBytes(sizeStr: string): number | null {
	if (!sizeStr || sizeStr.trim() === "") return null;

	const trimmed = sizeStr.trim().toUpperCase();

	// If it's just a number, treat as bytes
	if (/^\d+$/.test(trimmed)) {
		return parseInt(trimmed, 10);
	}

	// Extract number and unit - more flexible regex
	// Matches: "64 MB", "1.5GB", "1024KB", "500 B", "256K", "2M"
	const match = trimmed.match(/^([\d.]+)\s*([KMGT]?B?)$/);
	if (!match) return null;

	const value = parseFloat(match[1]);
	if (isNaN(value) || value < 0) return null;

	const unit = match[2] || "B";

	switch (unit) {
		case "B":
		case "":
			return Math.round(value);
		case "K":
		case "KB":
			return Math.round(value * 1024);
		case "M":
		case "MB":
			return Math.round(value * 1024 * 1024);
		case "G":
		case "GB":
			return Math.round(value * 1024 * 1024 * 1024);
		case "T":
		case "TB":
			return Math.round(value * 1024 * 1024 * 1024 * 1024);
		default:
			return null;
	}
}

/**
 * Check if a config key is size-related
 */
export function isSizeConfig(key: string): boolean {
	const sizeKeys = ["scriptMemoryLimit", "scriptStackSize", "maxJsonFieldSize"];
	return sizeKeys.includes(key);
}

/**
 * Format min/max values for size configs
 */
export function formatSizeRange(min?: string, max?: string): string | null {
	if (!min && !max) return null;

	const parts: string[] = [];
	if (min) {
		const minBytes = parseInt(min, 10);
		if (!isNaN(minBytes)) {
			parts.push(`Min: ${formatBytes(minBytes)}`);
		}
	}
	if (max) {
		const maxBytes = parseInt(max, 10);
		if (!isNaN(maxBytes)) {
			parts.push(`Max: ${formatBytes(maxBytes)}`);
		}
	}

	return parts.length > 0 ? parts.join(", ") : null;
}
