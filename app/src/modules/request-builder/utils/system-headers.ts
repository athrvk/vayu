
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * System Headers Utilities
 *
 * Centralized logic for managing system headers (User-Agent, X-Vayu-Version, X-Request-ID)
 * Keeps system header logic separate from UI components
 */

import type { KeyValueItem } from "../types";
import { generateId, generateUUID } from "./id";
import { createEmptyKeyValue } from "./key-value";

// System header keys (case-insensitive)
export const SYSTEM_HEADER_KEYS = new Set(["user-agent", "x-vayu-version", "x-request-id"]);
export const VERSION_HEADER_KEY = "x-vayu-version";

/**
 * Get Vayu version from package.json (injected at build time via Vite)
 */
const getVayuVersion = (): string => {
	return typeof __VAYU_VERSION__ !== "undefined" ? __VAYU_VERSION__ : "0.1.1";
};

/**
 * Create default system headers that can't be disabled or removed
 */
export const createDefaultSystemHeaders = (requestId?: string): KeyValueItem[] => {
	const version = getVayuVersion();
	const uuid = requestId || generateUUID();

	return [
		{
			id: generateId(),
			key: "User-Agent",
			value: `Vayu/${version}`,
			enabled: true,
			system: true,
		},
		{
			id: generateId(),
			key: "X-Vayu-Version",
			value: version,
			enabled: true,
			system: true,
		},
		{
			id: generateId(),
			key: "X-Request-ID",
			value: uuid,
			enabled: true,
			system: true,
		},
	];
};

/**
 * Ensure system headers are always present in headers array
 * Allows user overrides by adding new headers with same key (last one wins when converted to record)
 */
export const ensureSystemHeaders = (headers: KeyValueItem[]): KeyValueItem[] => {
	const systemHeaders = createDefaultSystemHeaders();
	const systemHeaderKeys = new Set(systemHeaders.map((h) => h.key.toLowerCase()));

	// Find existing system headers by key (preserve their IDs and allow value editing except version)
	const existingSystemHeaders: KeyValueItem[] = [];
	const userHeaders: KeyValueItem[] = [];

	headers.forEach((header) => {
		const headerKeyLower = header.key.toLowerCase();
		if (header.system || systemHeaderKeys.has(headerKeyLower)) {
			// Update system header with latest values but preserve ID
			const systemHeader = systemHeaders.find(
				(sh) => sh.key.toLowerCase() === headerKeyLower
			);
			if (systemHeader) {
				// Allow editing values except for version header
				const preservedValue =
					headerKeyLower === VERSION_HEADER_KEY
						? systemHeader.value // Never allow version override
						: header.value || systemHeader.value; // Allow user edits for other system headers

				existingSystemHeaders.push({
					...systemHeader,
					id: header.id, // Preserve existing ID
					value: preservedValue,
				});
			}
		} else {
			userHeaders.push(header);
		}
	});

	// Add any missing system headers
	systemHeaders.forEach((systemHeader) => {
		if (
			!existingSystemHeaders.some(
				(h) => h.key.toLowerCase() === systemHeader.key.toLowerCase()
			)
		) {
			existingSystemHeaders.push(systemHeader);
		}
	});

	// Return system headers first, then user headers, then empty row if needed
	const result = [...existingSystemHeaders, ...userHeaders];
	const lastItem = result[result.length - 1];
	if (!lastItem || lastItem.key.trim() || lastItem.value.trim()) {
		result.push(createEmptyKeyValue());
	}

	return result;
};

/**
 * Check if a header is a system header
 */
export const isSystemHeader = (item: KeyValueItem): boolean => {
	return item.system === true || SYSTEM_HEADER_KEYS.has(item.key.toLowerCase());
};

/**
 * Check if a header is the version header (protected)
 */
export const isVersionHeader = (item: KeyValueItem): boolean => {
	return item.key.toLowerCase() === VERSION_HEADER_KEY;
};

/**
 * Check if a field can be edited for a given header
 */
export const canEditHeaderField = (item: KeyValueItem, field: keyof KeyValueItem): boolean => {
	// Version header key/value cannot be edited
	if (isVersionHeader(item) && (field === "key" || field === "value")) {
		return false;
	}
	// All other fields can be edited
	return true;
};

/**
 * Check if a header can be removed
 */
export const canRemoveHeader = (item: KeyValueItem): boolean => {
	return !isSystemHeader(item);
};

/**
 * Check if a header can be disabled
 */
export const canDisableHeader = (item: KeyValueItem): boolean => {
	return !isSystemHeader(item);
};
