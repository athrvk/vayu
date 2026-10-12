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
 * Beside it, `dataFile: { path, fileName, hash? }` names the file the app
 * remembers for that collection on this machine, when the host has that record
 * (the Electron-hosted server; never the stdio CLI). `hash` is the SHA-256 of
 * the file's bytes when the app last read it (issue #2051), the digest a run
 * records as `dataFileHash`, so an agent can tell whether the file still is the
 * one a past run used; absent until the app has read the file once. Why a path
 * may be named at all is in `data-file-locations.ts`. The rows are never read
 * here.
 */

import type { DataFileLocation } from "../data-file-locations.js";

/** The one piece of the tool context this module reads. */
interface DataFileLookup {
	dataFileLocation?: (collectionId: string) => DataFileLocation | undefined;
}

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

/**
 * One collection row with its `dataSchema` stated or dropped, and its
 * remembered `dataFile` added when @p ctx knows one. Anything else passes
 * through.
 */
export function presentCollection(row: unknown, ctx?: DataFileLookup): unknown {
	if (!isRecord(row)) return row;
	const { dataSchema, ...rest } = row;
	const contract = readDataContract(dataSchema);
	const location = typeof row.id === "string" ? ctx?.dataFileLocation?.(row.id) : undefined;
	return {
		...rest,
		...(contract ? { dataSchema: contract } : {}),
		...(location ? { dataFile: presentLocation(location) } : {}),
	};
}

/** A remembered location as MCP names it: a path, a name and a digest, never contents. */
function presentLocation(location: DataFileLocation): DataFileLocation {
	return {
		path: location.path,
		fileName: location.fileName,
		...(location.hash !== undefined ? { hash: location.hash } : {}),
	};
}

/** {@link presentCollection} over a list; a non-list answer passes through untouched. */
export function presentCollections(list: unknown, ctx?: DataFileLookup): unknown {
	return Array.isArray(list) ? list.map((row) => presentCollection(row, ctx)) : list;
}

/** What list_collections and `vayu://collections` say about the field. */
export const DATA_CONTRACT_SENTENCE =
	"A collection with a declared data-file contract (the Data tab) carries `dataSchema: { columns, fileName, declaredAt }` - the columns each row of a run's `data` is expected to supply; a collection with none has no `dataSchema` key. When the Vayu app remembers where that file is on this machine, the row also carries `dataFile: { path, fileName, hash }`, `hash` being the SHA-256 of the file's bytes when the app last read it: read the file yourself to build the `data` rows, and send its name and hash with them as `dataFileName` / `dataFileHash`. A past run names the file it used the same way (list_runs), so comparing the hashes tells you whether the file is still the same. Vayu never returns the file's rows.";
