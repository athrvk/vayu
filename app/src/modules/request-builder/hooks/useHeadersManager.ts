/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Headers tab's rows, and the same list as bulk-edit text. A bulk draft's commit is the
 * provider's (`utils/bulk-drafts.ts`, #3666), since Send and Save commit an open draft too. Every
 * row is the user's (#1229); what Vayu adds is declared by the engine and shown beside the table.
 */

import { useCallback, useMemo } from "react";
import type { KeyValueItem } from "@/types";
import { withTrailingBlank } from "@/components/shared/KeyValueEditor/key-value";
import { formatHeadersToText } from "../utils/headers-format";

interface UseHeadersManagerOptions {
	headers: KeyValueItem[];
	onUpdate: (headers: KeyValueItem[]) => void;
}

interface UseHeadersManagerReturn {
	/** The rows to render, always ending in one blank row to type into. */
	displayHeaders: KeyValueItem[];

	handleHeadersChange: (headers: KeyValueItem[]) => void;

	formatForBulkEdit: () => string;
}

export function useHeadersManager({
	headers,
	onUpdate,
}: UseHeadersManagerOptions): UseHeadersManagerReturn {
	// A stored request arrives with the blank row (`toHeaderItems`), but a bulk commit and a
	// request whose last row was just removed do not, so the rule applies where rows render.
	const displayHeaders = useMemo(() => withTrailingBlank(headers), [headers]);

	const formatForBulkEdit = useCallback(() => {
		return formatHeadersToText(displayHeaders);
	}, [displayHeaders]);

	return {
		displayHeaders,
		handleHeadersChange: onUpdate,
		formatForBulkEdit,
	};
}
