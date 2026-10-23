/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one-time import of the file bindings the app kept in `localStorage`
 * before they rode the collection row (#2765).
 *
 * Each key is the payload the old zustand `persist` store wrote,
 * `{"state":{"locations":{<collectionId>:{...}}},"version":1}`, read through
 * the same normalizers a row is, and written to every collection the engine
 * still lists that has no binding of that kind yet - a binding the engine
 * already holds is never overwritten. An id the list does not name (a
 * collection deleted, or sitting in the trash, before the upgrade) is dropped.
 * The key is removed only once every write it asked for has landed, so a
 * launch that cannot reach the engine leaves it for the next.
 *
 * Retirement: this module, `useLegacyFileBindingImport` and
 * `LEGACY_FILE_BINDING_KEYS` go together once no supported release can leave
 * the keys behind - with the `file:` origin hand-off they are fed by
 * (`electron/legacy-storage-migration.ts`, #2763).
 */

import { asRecord } from "@/lib/json-node";
import { LEGACY_FILE_BINDING_KEYS } from "@/constants/storage-keys";
import {
	toDataFileLocation,
	toSpecFileLocation,
} from "@/services/transformers/collection-transformer";
import type { Collection } from "@/types";
import type { FileBindingUpdate } from "./file-bindings";

/** What the import reads and writes through, injected so its rules are testable. */
export interface LegacyFileBindingDeps {
	storage: Pick<Storage, "getItem" | "removeItem">;
	/** One binding-only collection update; rejects with the engine's error. */
	write: (update: FileBindingUpdate) => Promise<unknown>;
	/** A failure the import recovers from by trying again next launch. */
	log: (error: Error, action: string) => void;
}

/** One legacy key, the binding it held, and how an entry becomes that binding's write. */
interface LegacyKey {
	key: string;
	field: "specFile" | "dataFile";
	/** The write for one stored entry, or `undefined` when it names no file. */
	update: (id: string, entry: unknown) => FileBindingUpdate | undefined;
}

const LEGACY_KEYS: readonly LegacyKey[] = [
	{
		key: LEGACY_FILE_BINDING_KEYS.SPEC_FILES,
		field: "specFile",
		update: (id, entry) => {
			const specFile = toSpecFileLocation(entry);
			return specFile && { id, specFile };
		},
	},
	{
		key: LEGACY_FILE_BINDING_KEYS.DATA_FILES,
		field: "dataFile",
		update: (id, entry) => {
			const dataFile = toDataFileLocation(entry);
			return dataFile && { id, dataFile };
		},
	},
];

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * The entries a legacy payload holds, keyed by collection id, or `null` when
 * it is not one the old store could have written - which no later launch can
 * import either.
 */
function legacyEntries(raw: string): Record<string, unknown> | null {
	try {
		return asRecord(asRecord(asRecord(JSON.parse(raw))?.state)?.locations) ?? null;
	} catch {
		return null;
	}
}

/** Write one key's bindings, then remove it if every write landed. */
async function importKey(
	{ key, field, update }: LegacyKey,
	listed: ReadonlyMap<string, Collection>,
	deps: LegacyFileBindingDeps
): Promise<void> {
	const raw = deps.storage.getItem(key);
	if (raw === null) return;
	const entries = legacyEntries(raw);
	if (entries === null) {
		deps.log(new Error(`${key} is not a stored binding list; dropped`), "legacy-file-bindings");
	}

	const writes = Object.entries(entries ?? {}).flatMap(([id, entry]) => {
		const write = update(id, entry);
		const collection = listed.get(id);
		if (!write || !collection || collection[field]) return [];
		return [deps.write(write)];
	});
	const failures = (await Promise.allSettled(writes)).filter(
		(result): result is PromiseRejectedResult => result.status === "rejected"
	);
	for (const failure of failures) deps.log(asError(failure.reason), "legacy-file-bindings");
	if (failures.length === 0) deps.storage.removeItem(key);
}

/**
 * Move every legacy binding onto the rows in @p collections - the engine's
 * live list - and clear each key that moved whole. Never rejects: a failure
 * is logged and its key kept for the next launch.
 */
export async function importLegacyFileBindings(
	collections: readonly Collection[],
	deps: LegacyFileBindingDeps
): Promise<void> {
	const listed = new Map(collections.map((collection) => [collection.id, collection]));
	for (const legacyKey of LEGACY_KEYS) {
		try {
			await importKey(legacyKey, listed, deps);
		} catch (error) {
			// The storage itself refused (a read or a remove): the key stays.
			deps.log(asError(error), "legacy-file-bindings");
		}
	}
}
