/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Normalize a request or collection row's `elements` column (issue #1512).
 *
 * Shared by both transformers rather than duplicated: a request and a
 * collection carry the identical shape, and the "written but never read"
 * defect this codebase repeats is exactly a second reader drifting from the
 * first. A malformed entry (missing `id`/`kind`, or a `config` that is not an
 * object) is dropped rather than passed through - a `Request`/`Collection`
 * elsewhere in the app can otherwise assume every entry validates against its
 * kind's schema, which the engine already guarantees on write.
 */

import { asRecord, asStr } from "@/lib/json-node";
import type { ElementDef } from "@/types";

export function toElements(raw: unknown): ElementDef[] {
	if (!Array.isArray(raw)) return [];
	const result: ElementDef[] = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		if (!record) continue;
		const id = asStr(record.id);
		const kind = asStr(record.kind);
		if (!id || !kind) continue;
		const config = asRecord(record.config) ?? {};
		const name = asStr(record.name);
		result.push({
			id,
			kind,
			enabled: typeof record.enabled === "boolean" ? record.enabled : true,
			...(name ? { name } : {}),
			config,
		});
	}
	return result;
}
