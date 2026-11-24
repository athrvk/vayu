/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMemo, useState } from "react";
import type { SelectedDataFile } from "@/modules/collections/DataFilePicker";
import { describeDataSchemaDiff, describeUnboundReferences } from "@/services/data-files";
import { useDeclaredDataFile } from "@/hooks/useDeclaredDataFile";
import { useDataContractWriter } from "@/hooks/useDataContractWriter";
import { useColumnAudit, type ColumnAuditRequest } from "@/hooks/useColumnAudit";

const NO_COLUMNS: string[] = [];

/**
 * The data set a load run binds (#993), against the contract in scope for the request's collection.
 * Per run, deliberately not memoed like the profile: rows are user data of unknown sensitivity, and
 * neither side stores the set (the collection run dialog's rule). Picking the file again is the
 * cost, which the declared-file pre-fill spares without ever remembering the rows.
 */
export function useLoadTestDataFile(collectionId?: string, request?: ColumnAuditRequest) {
	/**
	 * The parse failure that blocks Start: a refused file leaves no rows, so the run would send its
	 * `{{data.*}}` tokens as written, the failure the namespace exists to prevent.
	 */
	const [error, setError] = useState<string | null>(null);

	/*
	 * The file against the contract in scope (the nearest declaring ancestor, as everywhere, #729).
	 * A mismatch warns, never blocks: a missing column fails loudly engine-side at bind, and extra
	 * columns are harmless; the gain is hearing it here, not at the first submission. Also the file
	 * the contract last ran with, pre-filled (#1039), from the hook the Run collection dialog
	 * reads, so the two cannot drift on the ancestor or on what a moved file says. Not carried
	 * over: that dialog's iterations coupling, since a load run's length is its profile's.
	 * `contract` comes from the same call because the audit and the pre-fill answer about one
	 * declaration.
	 */
	const {
		file,
		setFile,
		note: prefillNote,
		contract,
		dismissNote,
		declaringCollectionId,
	} = useDeclaredDataFile(collectionId);
	const writer = useDataContractWriter(declaringCollectionId);

	/*
	 * A pick declares the contract from the file (#2050), as the Run collection dialog and Data tab
	 * do: for the collection whose contract the request binds against, none outside a collection.
	 * Remove clears it through the picker's `onRemove`, not here, since a refused file also arrives
	 * as `null`. A failed declare leaves the selection, so Start still sends the rows. A hand pick
	 * replaces the pre-fill, so the re-read note has nothing left to say. No `onPrefill`: the run's
	 * length is its profile's, so an arriving file changes none of it.
	 */
	const select = (next: SelectedDataFile | null) => {
		setFile(next);
		if (next) {
			dismissNote();
			writer.declare(next);
		}
	};

	/*
	 * "Read numbers as numbers" re-parsed the file. Remembered on the binding when the collection
	 * has one; outside a collection it lives in the selection, for this run.
	 */
	const changeReading = (next: SelectedDataFile) => {
		setFile(next);
		writer.rememberReading(next);
	};

	/*
	 * The one request this run sends, audited under its collection's chain (its `inherit` auth and
	 * chain scripts are part of what it sends) against the file's columns. The contract diff is for
	 * a pre-filled file that drifted on disk; after a pick's declare it is empty, so the request is
	 * what is left to compare.
	 */
	const auditSubject = useMemo(
		() => ({ collectionId: collectionId ?? null, requests: request ? [request] : [] }),
		[collectionId, request]
	);
	const { audit } = useColumnAudit(auditSubject, file?.parsed.columns ?? NO_COLUMNS);
	const warnings = file
		? [
				...describeDataSchemaDiff(contract?.columns ?? [], file.parsed.columns),
				...describeUnboundReferences(audit.undeclared),
			]
		: [];

	return {
		file,
		error,
		setError,
		select,
		changeReading,
		prefillNote,
		warnings,
		/** Present only when there is a declared contract for Remove to clear. */
		clearContract: contract ? writer.clear : undefined,
		/** The failed contract write, wrapped so an empty message still counts as one. */
		writerError: writer.isError
			? { message: writer.error?.message ?? "Vayu's engine didn't accept the change." }
			: null,
	};
}

export type LoadTestDataFile = ReturnType<typeof useLoadTestDataFile>;
