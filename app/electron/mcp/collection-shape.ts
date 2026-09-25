/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file collection-shape.ts
 * @brief A collection row as the MCP surface hands it back (issue #1742).
 *
 * The engine answers `dataSchema: {}` for a collection with no declared data
 * contract, and a cleared contract is `{}` too. An agent reading that `{}`
 * cannot tell "no contract" from "a contract this reader failed to parse", so
 * every tool and resource that returns a collection row passes it through
 * here: a declared contract comes back as `{ columns, fileName?, declaredAt? }`,
 * and no contract drops the key rather than sending an empty placeholder.
 *
 * "Declared" is the renderer's `hasDataContract` rule (a non-empty `columns`
 * list), restated because `electron/` cannot import from `app/src`;
 * `collection-shape.conformance.test.ts` holds the two to the same answers.
 *
 * Only the column names ride this: the file's path and its rows never reach
 * the engine (`data-file-store.ts`), so there is nothing else to show.
 */

export interface DataContract {
	columns: string[];
	fileName?: string;
	declaredAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The declared contract a stored `dataSchema` holds, or `null` for none. */
export function readDataContract(schema: unknown): DataContract | null {
	if (!isRecord(schema) || !Array.isArray(schema.columns)) return null;
	const columns = schema.columns.filter((c): c is string => typeof c === "string");
	if (columns.length === 0) return null;
	return {
		columns,
		...(typeof schema.fileName === "string" && schema.fileName !== ""
			? { fileName: schema.fileName }
			: {}),
		...(typeof schema.declaredAt === "number" ? { declaredAt: schema.declaredAt } : {}),
	};
}

/** One collection row with its `dataSchema` stated or dropped. Anything else passes through. */
export function presentCollection(row: unknown): unknown {
	if (!isRecord(row) || !("dataSchema" in row)) return row;
	const { dataSchema, ...rest } = row;
	const contract = readDataContract(dataSchema);
	return contract ? { ...rest, dataSchema: contract } : rest;
}

/** {@link presentCollection} over a list; a non-list answer passes through untouched. */
export function presentCollections(list: unknown): unknown {
	return Array.isArray(list) ? list.map(presentCollection) : list;
}

/** What list_collections and `vayu://collections` say about the field. */
export const DATA_CONTRACT_SENTENCE =
	"A collection with a declared data-file contract (the Data tab) carries `dataSchema: { columns, fileName, declaredAt }` - the columns each row of a run's `data` is expected to supply; a collection with none has no `dataSchema` key. The file's path and rows stay in the app and are never exposed.";
