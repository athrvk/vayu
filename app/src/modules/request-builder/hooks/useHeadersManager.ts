/**
 * useHeadersManager Hook
 *
 * Centralized hook for managing request headers with system header support
 * Handles:
 * - System header management
 * - Header updates
 * - Bulk edit operations
 * - Editability checks
 */

import { useCallback, useMemo } from "react";
import type { KeyValueItem } from "../types";
import { ensureSystemHeaders } from "../utils/system-headers";
import { canEditHeaderField, canRemoveHeader, canDisableHeader } from "../utils/system-headers";
import { formatHeadersToText, parseHeadersFromText } from "../utils/headers-format";

interface UseHeadersManagerOptions {
	headers: KeyValueItem[];
	onUpdate: (headers: KeyValueItem[]) => void;
}

interface UseHeadersManagerReturn {
	// Current headers with system headers ensured
	displayHeaders: KeyValueItem[];

	// Handlers
	handleHeadersChange: (newHeaders: KeyValueItem[]) => void;
	handleBulkEdit: (text: string) => void;

	// Formatting
	formatForBulkEdit: () => string;

	// Editability checks (for KeyValueEditor callbacks)
	canEdit: (item: KeyValueItem, field: keyof KeyValueItem) => boolean;
	canRemove: (item: KeyValueItem) => boolean;
	canDisable: (item: KeyValueItem) => boolean;
}

export function useHeadersManager({
	headers,
	onUpdate,
}: UseHeadersManagerOptions): UseHeadersManagerReturn {
	// Ensure system headers are always present
	const displayHeaders = useMemo(() => {
		return ensureSystemHeaders(headers);
	}, [headers]);

	// Handle headers change from KeyValueEditor
	const handleHeadersChange = useCallback(
		(newHeaders: KeyValueItem[]) => {
			const headersWithSystem = ensureSystemHeaders(newHeaders);
			onUpdate(headersWithSystem);
		},
		[onUpdate]
	);

	// Handle bulk edit text
	const handleBulkEdit = useCallback(
		(text: string) => {
			const parsedHeaders = parseHeadersFromText(text, true); // Skip version header
			const headersWithSystem = ensureSystemHeaders(parsedHeaders);
			onUpdate(headersWithSystem);
		},
		[onUpdate]
	);

	// Format headers for bulk edit display
	const formatForBulkEdit = useCallback(() => {
		return formatHeadersToText(displayHeaders);
	}, [displayHeaders]);

	// Editability callbacks for KeyValueEditor
	const canEdit = useCallback((item: KeyValueItem, field: keyof KeyValueItem) => {
		return canEditHeaderField(item, field);
	}, []);

	const canRemove = useCallback((item: KeyValueItem) => {
		return canRemoveHeader(item);
	}, []);

	const canDisable = useCallback((item: KeyValueItem) => {
		return canDisableHeader(item);
	}, []);

	return {
		displayHeaders,
		handleHeadersChange,
		handleBulkEdit,
		formatForBulkEdit,
		canEdit,
		canRemove,
		canDisable,
	};
}
