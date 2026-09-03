/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useHeadersManager Hook
 *
 * The Headers tab's two ways of editing the same list: the table and the
 * bulk-edit text.
 *
 * It used to re-impose three managed system rows on every change and answer
 * "may this row be edited / removed / disabled" for the table. Neither exists
 * since issue #1229: every row in the headers table is the user's, and what
 * Vayu adds is declared by the engine and shown beside the table rather than
 * written into it.
 */

import { useCallback, useMemo } from "react";
import type { KeyValueItem } from "@/types";
import { withTrailingBlank } from "@/components/shared/KeyValueEditor/key-value";
import { formatHeadersToText, parseHeadersFromText } from "../utils/headers-format";

interface UseHeadersManagerOptions {
	headers: KeyValueItem[];
	onUpdate: (headers: KeyValueItem[]) => void;
}

interface UseHeadersManagerReturn {
	/** The rows to render, always ending in one blank row to type into. */
	displayHeaders: KeyValueItem[];

	// Handlers
	handleHeadersChange: (headers: KeyValueItem[]) => void;
	handleBulkEdit: (text: string) => void;

	// Formatting
	formatForBulkEdit: () => string;
}

export function useHeadersManager({
	headers,
	onUpdate,
}: UseHeadersManagerOptions): UseHeadersManagerReturn {
	// A stored request arrives with the blank row already (`toHeaderItems`), but
	// a bulk-edit commit does not, and neither does a request whose last row was
	// just removed - so the rule is applied where the rows are rendered.
	const displayHeaders = useMemo(() => withTrailingBlank(headers), [headers]);

	const handleBulkEdit = useCallback(
		(text: string) => {
			onUpdate(withTrailingBlank(parseHeadersFromText(text)));
		},
		[onUpdate]
	);

	const formatForBulkEdit = useCallback(() => {
		return formatHeadersToText(displayHeaders);
	}, [displayHeaders]);

	return {
		displayHeaders,
		handleHeadersChange: onUpdate,
		handleBulkEdit,
		formatForBulkEdit,
	};
}
