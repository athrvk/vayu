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
 * Supports formats like: "64 MB", "1.5GB", "1024KB", "500 B"
 */
export function parseSizeToBytes(sizeStr: string): number | null {
	const trimmed = sizeStr.trim().toUpperCase();
	
	// Extract number and unit
	const match = trimmed.match(/^([\d.]+)\s*([KMGT]?B?)$/);
	if (!match) return null;
	
	const value = parseFloat(match[1]);
	if (isNaN(value)) return null;
	
	const unit = match[2] || "B";
	
	switch (unit) {
		case "B":
		case "":
			return Math.round(value);
		case "KB":
			return Math.round(value * 1024);
		case "MB":
			return Math.round(value * 1024 * 1024);
		case "GB":
			return Math.round(value * 1024 * 1024 * 1024);
		default:
			return null;
	}
}

/**
 * Check if a config key is size-related
 */
export function isSizeConfig(key: string): boolean {
	const sizeKeys = [
		"scriptMemoryLimit",
		"scriptStackSize",
		"maxJsonFieldSize",
	];
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
