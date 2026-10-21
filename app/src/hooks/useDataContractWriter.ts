/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two writes that change a collection's data contract (issue #2050):
 * declare it from a file, or clear it - plus the one that changes only how the
 * bound file is read (`rememberReading`, #2540). Shared by every surface where a
 * pick or a Remove names the file a contract comes from, so the rules about
 * *when* the remembered binding is written live once.
 *
 * Two halves, stored in two places on purpose: the schema rides the engine row
 * (`dataSchema`, the same on every machine), the file's path stays in
 * `data-file-store` (true of one filesystem only). The store is written only
 * after the engine accepts the schema, so it never names a file whose columns
 * were not declared.
 */

import { useCallback } from "react";

import { useUpdateCollectionMutation } from "@/queries/collections";
import { useDataFileStore } from "@/stores";
import type { SelectedDataFile } from "@/modules/collections/DataFilePicker";

export interface DataContractWriter {
	/** Declare the contract from `file`'s columns, and remember where it is. */
	declare: (file: SelectedDataFile) => void;
	/** Drop the contract and the remembered path with it. */
	clear: () => void;
	/**
	 * Remember how `file` is read - its `castNumbers` (#2540) - on the binding,
	 * when the binding names that file. Writes no contract: the columns do not
	 * change with how a value is read.
	 */
	rememberReading: (file: SelectedDataFile) => void;
	isPending: boolean;
	isError: boolean;
	error: Error | null;
}

/**
 * @param collectionId The collection whose contract is written. Empty or
 *        absent makes both writes no-ops: a request in no collection has no
 *        contract to declare, and a pick there stays a plain run input.
 */
export function useDataContractWriter(collectionId: string | null | undefined): DataContractWriter {
	const { mutate, isPending, isError, error } = useUpdateCollectionMutation();
	const setDataFile = useDataFileStore((s) => s.setDataFile);
	const clearDataFile = useDataFileStore((s) => s.clearDataFile);
	const setDataFileCastNumbers = useDataFileStore((s) => s.setDataFileCastNumbers);

	const declare = useCallback(
		(file: SelectedDataFile) => {
			if (!collectionId) return;
			mutate(
				{
					id: collectionId,
					dataSchema: {
						columns: file.parsed.columns,
						declaredAt: Date.now(),
						fileName: file.fileName,
					},
				},
				{
					onSuccess: () => {
						// A file with no path (a browser, a remote drop) forgets the
						// previous one instead, so the store never names a file the
						// contract was not read from.
						if (file.path) {
							setDataFile(collectionId, {
								path: file.path,
								fileName: file.fileName,
								hash: file.hash,
								castNumbers: file.parsed.castNumbers,
							});
						} else {
							clearDataFile(collectionId);
						}
					},
				}
			);
		},
		[collectionId, mutate, setDataFile, clearDataFile]
	);

	const clear = useCallback(() => {
		if (!collectionId) return;
		// `null`, not `{}`: the engine reads absent as "keep" and null as "reset
		// to the default", and the default is no contract. The remembered path
		// goes with it - a file remembered for a collection that declares nothing
		// would pre-fill a run with a file the user has stopped asserting is the
		// right one.
		mutate(
			{ id: collectionId, dataSchema: null },
			{ onSuccess: () => clearDataFile(collectionId) }
		);
	}, [collectionId, mutate, clearDataFile]);

	const rememberReading = useCallback(
		(file: SelectedDataFile) => {
			if (!collectionId || !file.path) return;
			setDataFileCastNumbers(collectionId, file.path, file.parsed.castNumbers);
		},
		[collectionId, setDataFileCastNumbers]
	);

	return { declare, clear, rememberReading, isPending, isError, error };
}
