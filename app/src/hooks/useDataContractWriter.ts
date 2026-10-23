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
 * *when* the file binding is written live once.
 *
 * The schema and the file it was read from are written together, in one
 * collection update (`dataSchema` + `dataFile`, #2765), so the engine never
 * holds a binding to a file whose columns were not declared, nor a contract
 * whose file belongs to an earlier declare.
 */

import { useCallback } from "react";

import { useDataFileReadingMutation, useUpdateCollectionMutation } from "@/queries/collections";
import { readsDifferently } from "@/queries/file-bindings";
import { useDataFileStore } from "@/stores";
import type { DataFileLocation } from "@/types";
import type { SelectedDataFile } from "@/modules/collections/DataFilePicker";

export interface DataContractWriter {
	/** Declare the contract from `file`'s columns, and bind the file it came from. */
	declare: (file: SelectedDataFile) => void;
	/** Drop the contract and the file binding with it. */
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
	const contract = useUpdateCollectionMutation();
	const reading = useDataFileReadingMutation();
	const { mutate } = contract;
	const { mutate: mutateReading } = reading;

	const declare = useCallback(
		(file: SelectedDataFile) => {
			if (!collectionId) return;
			mutate({
				id: collectionId,
				dataSchema: {
					columns: file.parsed.columns,
					declaredAt: Date.now(),
					fileName: file.fileName,
				},
				dataFile: fileBinding(file),
			});
		},
		[collectionId, mutate]
	);

	const clear = useCallback(() => {
		if (!collectionId) return;
		// `null`, not `{}`: the engine reads absent as "keep" and null as "reset
		// to the default", and the default is no contract. The binding goes with
		// it - a file bound to a collection that declares nothing would pre-fill
		// a run with a file the user has stopped asserting is the right one.
		mutate({ id: collectionId, dataSchema: null, dataFile: null });
	}, [collectionId, mutate]);

	const rememberReading = useCallback(
		(file: SelectedDataFile) => {
			if (!collectionId || !file.path) return;
			const castNumbers = file.parsed.castNumbers;
			// Checked again when the write is sent; this keeps a toggle that
			// changes nothing from becoming a pending write.
			const bound = useDataFileStore.getState().locations[collectionId];
			if (!readsDifferently(bound, file.path, castNumbers)) return;
			mutateReading({ id: collectionId, path: file.path, castNumbers });
		},
		[collectionId, mutateReading]
	);

	return {
		declare,
		clear,
		rememberReading,
		isPending: contract.isPending || reading.isPending,
		isError: contract.isError || reading.isError,
		error: contract.error ?? reading.error,
	};
}

/**
 * The binding a declare writes beside the columns: where `file` is, the hash of
 * the bytes the columns were read from, and how its values were read. A file
 * with no path (a browser, a remote drop) binds nothing and forgets the
 * previous file, so the binding never names a file the contract was not read
 * from. Never the rows.
 */
function fileBinding(file: SelectedDataFile): DataFileLocation | null {
	if (!file.path) return null;
	return {
		path: file.path,
		fileName: file.fileName,
		hash: file.hash,
		castNumbers: file.parsed.castNumbers,
	};
}
