
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Collection Transformer
 *
 * Transforms backend collection format to frontend domain Collection type.
 * Handles timestamp conversion and provides safe defaults for new fields.
 */

import type { Collection, RequestAuth } from "@/types";

export class CollectionTransformer {
	static toFrontend(raw: Record<string, any>): Collection {
		if (!raw.id) throw new Error("Collection must have an id");

		// Auth: defaults to {mode: "none"} if missing or malformed
		let auth: Exclude<RequestAuth, { mode: "inherit" }> = { mode: "none" };
		if (raw.auth && typeof raw.auth === "object" && raw.auth.mode && raw.auth.mode !== "inherit") {
			auth = raw.auth as Exclude<RequestAuth, { mode: "inherit" }>;
		}

		return {
			id: raw.id,
			name: raw.name ?? "",
			description: raw.description ?? "",
			parentId: raw.parentId ?? undefined,
			order: raw.order ?? 0,
			variables: raw.variables ?? {},
			auth,
			preRequestScript: raw.preRequestScript ?? "",
			postRequestScript: raw.postRequestScript ?? "",
			createdAt: new Date(raw.createdAt).toISOString(),
			updatedAt: new Date(raw.updatedAt).toISOString(),
		};
	}
}
