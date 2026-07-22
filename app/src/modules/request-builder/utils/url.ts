/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * URL utilities for the request builder.
 */

import type { KeyValueItem } from "../types";
import { generateId } from "./id";

/**
 * Parse the query string of a URL into key/value items.
 *
 * Variable tokens (`{{var}}`) are preserved verbatim - decoding is skipped for
 * any segment that contains them so the variable syntax survives round-trips.
 */
export function parseQueryParams(url: string): KeyValueItem[] {
	try {
		const queryStart = url.indexOf("?");
		if (queryStart === -1) return [];

		const queryString = url.slice(queryStart + 1);
		if (!queryString) return [];

		const pairs = queryString.split("&").filter(Boolean);

		return pairs.map((pair) => {
			const [key, ...valueParts] = pair.split("=");
			const value = valueParts.join("=");
			return {
				id: generateId(),
				key: safeDecode(key || ""),
				value: safeDecode(value || ""),
				enabled: true,
			};
		});
	} catch {
		return [];
	}
}

/** decodeURIComponent that leaves `{{var}}` tokens (and malformed input) untouched. */
function safeDecode(part: string): string {
	if (part.includes("{{")) return part;
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}
