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

import type { Collection, CollectionDataSchema, RequestAuth, VariableValue } from "@/types";
import { asRecord, asStr } from "@/lib/json-node";

/**
 * The declared data contract, or `{}` when the row predates the column or holds
 * something that is not a schema.
 *
 * Normalized field by field rather than cast: this row can come from an engine
 * older than the `data_schema` column, and every consumer downstream (the tab's
 * diff, the runner's warnings) treats `columns` as a string array without
 * re-checking. A blob that got in another way must not become the first
 * `undefined` the diff iterates.
 */
function toDataSchema(raw: unknown): CollectionDataSchema {
	const record = asRecord(raw);
	if (!record) return {};
	const schema: CollectionDataSchema = {};
	if (Array.isArray(record.columns)) {
		schema.columns = record.columns.filter((c): c is string => typeof c === "string");
	}
	if (typeof record.declaredAt === "number") schema.declaredAt = record.declaredAt;
	if (typeof record.fileName === "string") schema.fileName = record.fileName;
	return schema;
}

/**
 * A collection row as the engine sends it. Typed as a bag of unknowns rather
 * than as `Collection`: the wire row carries numeric timestamps and may predate
 * a column, which is exactly what this transformer exists to reconcile.
 */
export type RawCollection = Record<string, unknown>;

export class CollectionTransformer {
	static toFrontend(raw: RawCollection): Collection {
		const id = asStr(raw.id);
		if (!id) throw new Error("Collection must have an id");

		// Auth: defaults to {mode: "none"} if missing or malformed
		let auth: Exclude<RequestAuth, { mode: "inherit" }> = { mode: "none" };
		const rawAuth = asRecord(raw.auth);
		if (rawAuth && rawAuth.mode && rawAuth.mode !== "inherit") {
			auth = rawAuth as Exclude<RequestAuth, { mode: "inherit" }>;
		}

		return {
			id,
			name: asStr(raw.name) ?? "",
			description: asStr(raw.description) ?? "",
			parentId: asStr(raw.parentId) ?? undefined,
			order: typeof raw.order === "number" ? raw.order : 0,
			variables: (asRecord(raw.variables) ?? {}) as Record<string, VariableValue>,
			preRequestScript: asStr(raw.preRequestScript) ?? "",
			postRequestScript: asStr(raw.postRequestScript) ?? "",
			dataSchema: toDataSchema(raw.dataSchema),
			auth,
			createdAt: new Date(raw.createdAt as string | number).toISOString(),
			updatedAt: new Date(raw.updatedAt as string | number).toISOString(),
		};
	}
}
