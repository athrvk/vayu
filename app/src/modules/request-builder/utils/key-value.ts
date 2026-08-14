/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Execution-shaped key/value helpers.
 *
 * The row-model half of this file - `createEmptyKeyValue`, `withTrailingBlank`,
 * `toKeyValueItems`, `toKeyValueEntries` - moved to
 * `components/shared/KeyValueEditor/key-value.ts` with the table it describes
 * (issue #567). What is left is the one helper no table asks for: the flat
 * header record the engine's execute endpoint takes.
 */

import type { KeyValueItem } from "@/types";

/**
 * Build a flat Record<string,string> from KeyValueItems for HTTP execution.
 * Only enabled rows with non-empty keys are included.
 * Last value wins when duplicate keys exist (allows user headers to override system headers).
 * This is ONLY used for the engine execution endpoint - never for storage.
 */
export const toFlatHeaders = (items: KeyValueItem[]): Record<string, string> => {
	const result: Record<string, string> = {};
	items.forEach((item) => {
		if (item.enabled && item.key.trim()) {
			result[item.key] = item.value;
		}
	});
	return result;
};
