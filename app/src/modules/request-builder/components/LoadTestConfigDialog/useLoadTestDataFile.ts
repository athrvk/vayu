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
 * The data set a load run binds (issue #993), against the contract in scope
 * for the request's collection.
 *
 * Per-run and deliberately not memoed like the profile's numbers: rows are user
 * data of unknown sensitivity, and neither side stores the set - the same rule
 * the collection run dialog keeps. Picking a file again is the whole cost of
 * that - which is what the declared-file pre-fill spares the user, without the
 * rows ever being what is remembered.
 */
export function useLoadTestDataFile(collectionId?: string, request?: ColumnAuditRequest) {
	/**
	 * The parse failure that blocks starting: a file the parser refused leaves
	 * no rows behind, so starting the run would send the request with its
	 * `{{data.*}}` tokens written as they stand - the failure the whole
	 * namespace exists to prevent.
	 */
	const [error, setError] = useState<string | null>(null);

	/*
	 * The chosen file against the contract in scope for this request's
	 * collection - the nearest declaring ancestor, as everywhere else in the
	 * feature (issue #729). A mismatch is a warning and never blocks: a missing
	 * column fails loudly engine-side at bind time, and a file carrying extra
	 * columns is simply a file with extra columns. What it buys is hearing about
	 * it here rather than at the first submission.
	 *
	 * ...and the file that contract was last run with, pre-filled (issue #1039).
	 * The same hook the Run collection dialog reads, so the two cannot drift on
	 * which ancestor is consulted or on what a moved file says. What does *not*
	 * come across with it is that dialog's iterations coupling: a load run's
	 * length is its profile's, so nothing about a data file may touch the
	 * profile's fields. `contract` comes back from the same call because the
	 * audit and the pre-fill are answers about the same declaration.
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
	 * A pick declares the contract from the picked file (issue #2050), the same
	 * rule as the Run collection dialog and the Data tab: for the collection whose
	 * contract this request binds against, and for nothing when the request is in
	 * no collection. Remove clears it through the picker's `onRemove`, never
	 * here, because a file the picker refuses also arrives as `null`. A declare
	 * that fails leaves the selection alone, so Start still sends the rows.
	 *
	 * Picking by hand also replaces whatever was pre-filled, so the note about a
	 * file that could not be re-read has nothing left to say. And no
	 * `onPrefill`: a load run's length is its profile's, so a file arriving
	 * changes no field of it.
	 */
	const select = (next: SelectedDataFile | null) => {
		setFile(next);
		if (next) {
			dismissNote();
			writer.declare(next);
		}
	};

	/*
	 * The one request this run sends, audited under its collection's chain (its
	 * `inherit` auth and the chain's scripts are part of what it sends) against
	 * the picked file's columns. The contract diff beside it is for a pre-filled
	 * file that drifted on disk; once a pick's declare lands it is empty by
	 * construction, and the request is what is left to compare against.
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
