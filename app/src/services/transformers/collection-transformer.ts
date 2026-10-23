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

import type {
	Collection,
	CollectionDataSchema,
	CollectionOpenApiBinding,
	DataFileLocation,
	RequestAuth,
	SpecFileLocation,
	VariableValue,
} from "@/types";
import { asRecord, asStr } from "@/lib/json-node";
import { DATA_FILE_HASH_PATTERN } from "@/services/data-files/hash";
import { toElements } from "./elements-transformer";

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
 * The bound spec document, or `{}` when the row predates the column, is
 * unbound, or holds something that is not a binding.
 *
 * Field by field for the same reason `toDataSchema` is: `specId` is what every
 * reader keys the binding off (`hasSpecBinding`), and a non-string that got in
 * another way must not become the id a `GET /specs/:id` is built from.
 */
function toOpenApiBinding(raw: unknown): CollectionOpenApiBinding {
	const record = asRecord(raw);
	if (!record) return {};
	const binding: CollectionOpenApiBinding = {};
	const specId = asStr(record.specId);
	if (specId) binding.specId = specId;
	const specHash = asStr(record.specHash);
	if (specHash) binding.specHash = specHash;
	if (typeof record.syncedAt === "number") binding.syncedAt = record.syncedAt;
	return binding;
}

/**
 * A stored spec-file location, or `undefined` for none (#2765).
 *
 * Rebuilt rather than trusted: whatever this answers reaches the read IPC *as a
 * path*, so a value that is not a `{path, fileName}` pair of non-empty strings
 * is no location at all. Dropping it is right where repairing it is not -
 * there is nothing to repair a path *to*, and the picker is one click away.
 * The engine's `{}` for "no file" lands here too. Exported for the one-time
 * import of the locations the app used to keep in `localStorage`.
 */
export function toSpecFileLocation(raw: unknown): SpecFileLocation | undefined {
	const record = asRecord(raw);
	const path = asStr(record?.path);
	const fileName = asStr(record?.fileName);
	if (!path || !fileName) return undefined;
	return { path, fileName };
}

/**
 * A stored data-file location, or `undefined` for none - see
 * {@link toSpecFileLocation}. A malformed `hash` drops the hash, not the
 * location (the next read of the path records a good one), and a `castNumbers`
 * that is not a boolean reads as off: the file's own text, the safe reading.
 */
export function toDataFileLocation(raw: unknown): DataFileLocation | undefined {
	const location = toSpecFileLocation(raw);
	const record = asRecord(raw);
	if (!location || !record) return undefined;
	const hash = asStr(record.hash);
	return {
		...location,
		...(hash && DATA_FILE_HASH_PATTERN.test(hash) ? { hash } : {}),
		...(typeof record.castNumbers === "boolean" ? { castNumbers: record.castNumbers } : {}),
	};
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

		const specFile = toSpecFileLocation(raw.specFile);
		const dataFile = toDataFileLocation(raw.dataFile);
		return {
			id,
			name: asStr(raw.name) ?? "",
			description: asStr(raw.description) ?? "",
			parentId: asStr(raw.parentId) ?? undefined,
			order: typeof raw.order === "number" ? raw.order : 0,
			variables: (asRecord(raw.variables) ?? {}) as Record<string, VariableValue>,
			elements: toElements(raw.elements),
			dataSchema: toDataSchema(raw.dataSchema),
			openapi: toOpenApiBinding(raw.openapi),
			...(specFile ? { specFile } : {}),
			...(dataFile ? { dataFile } : {}),
			auth,
			createdAt: new Date(raw.createdAt as string | number).toISOString(),
			updatedAt: new Date(raw.updatedAt as string | number).toISOString(),
		};
	}
}
