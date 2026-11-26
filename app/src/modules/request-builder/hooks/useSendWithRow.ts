/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The rows a single Send can bind, for this request (#601), so a script reading `pm.iterationData`
 * is testable without a collection run. It answers *which* rows are available from:
 *
 * - **the contract in scope** (`useDataContract`, the leaf-to-root chain rule), which says the
 *   request's collection is data-driven; and
 * - **the file that contract was declared from** (the declaring collection's `dataFile`, by id from
 *   `data-file-store`), machine-local, which is why it is not "any file".
 *
 * The file is read **when the picker opens**, never on mount: a mounting tab must not touch the
 * filesystem unasked, and the rows must never be persisted or held past the send using them
 * (`data-file-store`). A moved file is a *note*, not an error toast: the fix is picking it again in
 * the Data tab, and the affordance says so, as `RunCollectionDialog`'s pre-fill does.
 */

import { useCallback, useState } from "react";

import { useDataFileStore } from "@/stores";
import { DataFileError, type ParsedDataFile } from "@/services/data-files";
import { canReadDeclaredDataFile, readDeclaredDataFile } from "@/services/data-files/read-declared";
import type { DataContractScope } from "@/types";

/** Why the rows are not available, in a sentence the affordance can show. */
export type SendWithRowStatus = "idle" | "loading" | "ready" | "unavailable";

export interface SendWithRowState {
	/**
	 * Whether a row can be bound at all: a contract in scope and a remembered file for its
	 * declaring collection. The affordance is **absent**, not disabled, when false: outside a
	 * data-driven collection a disabled "Send with row" promises what the request cannot do. The
	 * one disabled state is a moved file, which is repairable and named.
	 */
	available: boolean;
	/** The contract that made it available, for naming the declaring collection. */
	contract: DataContractScope | undefined;
	/** The declared file's name, for the message about a file that moved. */
	fileName: string | undefined;
	status: SendWithRowStatus;
	/** The parsed file, once read. Null until the picker has been opened. */
	parsed: ParsedDataFile | null;
	/** Why the file could not be read, if it could not. */
	error: string | null;
	/** Read and parse the declared file. Idempotent while a read is in flight. */
	load: () => void;
}

/**
 * @param contract The contract in scope, the context's `dataColumns`, passed in on purpose:
 *        `useDataContract` reads the collections query, and a UrlBar needing a
 *        `QueryClientProvider` is the coupling #564 removed and #600 kept out of the token painter.
 * @param maxRows The live `maxScenarioDataRows` (#751), the context's `dataFileMaxRows`, for the
 *        same reason. The cap bounds a *run* and a Send binds one row, but the file is the
 *        collection's set: one the picker would refuse offers no rows, else a request would send
 *        happily beside a collection that cannot run.
 */
export function useSendWithRow(
	contract: DataContractScope | undefined,
	maxRows: number
): SendWithRowState {
	// Keyed by the collection that *declared* the contract, not the request's parent: under the
	// chain rule a sub-collection inherits it, and the file was picked in the ancestor's Data tab.
	const location = useDataFileStore((s) =>
		contract ? s.locations[contract.collectionId] : undefined
	);

	const [status, setStatus] = useState<SendWithRowStatus>("idle");
	const [parsed, setParsed] = useState<ParsedDataFile | null>(null);
	const [error, setError] = useState<string | null>(null);

	const path = location?.path;
	const fileName = location?.fileName;
	// Read as the binding says, so a Send binds the row a run would (#2540).
	const castNumbers = location?.castNumbers ?? false;

	const load = useCallback(() => {
		if (!path) return;
		if (!canReadDeclaredDataFile()) {
			// No Electron, no path to re-read: said plainly, not a spinner that never resolves.
			setStatus("unavailable");
			setError("Reading the declared data file needs the desktop app.");
			return;
		}
		setStatus("loading");
		setError(null);
		void readDeclaredDataFile(path, { maxRows, castNumbers })
			.then((read) => {
				setParsed(read.parsed);
				setStatus("ready");
			})
			.catch((e: unknown) => {
				setParsed(null);
				setStatus("unavailable");
				setError(
					e instanceof DataFileError || e instanceof Error
						? e.message
						: `The declared file is no longer at ${fileName ?? "its recorded path"} - pick it again in the Data tab.`
				);
			});
	}, [path, fileName, castNumbers, maxRows]);

	return {
		available: !!contract && !!path,
		contract,
		fileName,
		status,
		parsed,
		error,
		load,
	};
}
