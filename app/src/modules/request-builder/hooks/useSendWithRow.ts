/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useSendWithRow - the rows a single Send can bind, for this request (#601).
 *
 * A pre-request script reading `pm.iterationData` used to be untestable without
 * launching a collection run: the row only ever arrived through a scenario, so
 * the edit loop was "start a run, find the step, read the result". This hook is
 * the authoring-time half of closing that - it answers *which* rows are
 * available to bind, from the two things phases 1 and 2 already established:
 *
 * - **the contract in scope** (`useDataContract`, the leaf-to-root chain rule),
 *   which says this request's collection is data-driven at all; and
 * - **the file that contract was declared from** (`data-file-store`), which is
 *   machine-local and therefore the reason this is not simply "any file".
 *
 * The file is read **when the picker opens**, never on mount. A request tab
 * mounting must not touch the filesystem for a Send the user has not asked for,
 * and the rows are the one thing in this feature that must never be persisted
 * or held longer than the send that uses them (see `data-file-store`).
 *
 * A file that has moved is a *note*, not an error toast: the fix is picking it
 * again in the Data tab, and the affordance says so rather than vanishing - the
 * same rule `RunCollectionDialog`'s pre-fill follows.
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
	 * Whether this request can be sent with a row at all - a contract in scope
	 * and a remembered file for the collection that declared it.
	 *
	 * The affordance is **absent** when this is false rather than disabled: a
	 * request outside a data-driven collection has nothing to bind, and a
	 * disabled control offering "Send with row" would be a promise the request
	 * cannot keep. The one disabled-with-a-reason state is a file that moved,
	 * which is a repairable condition and named as such.
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
 * @param contract The contract in scope, from the builder context's
 *        `dataColumns`. Passed in rather than resolved here, deliberately:
 *        `useDataContract` reads the collections query, and a UrlBar that
 *        needed a `QueryClientProvider` to render is the coupling issue #564
 *        removed from the variable slice and #600 kept out of the token
 *        painter. The provider already holds this answer.
 * @param maxRows The live `maxScenarioDataRows` (issue #751), from the builder
 *        context's `dataFileMaxRows` - and for the same reason as the contract,
 *        since it is the config query that knows it. The cap bounds a *run* and
 *        a Send binds one row, but the file is the collection's data set: one
 *        the picker would refuse is not a set to offer rows out of, and letting
 *        it through here would mean a request sending happily beside a
 *        collection that cannot run at all.
 */
export function useSendWithRow(
	contract: DataContractScope | undefined,
	maxRows: number
): SendWithRowState {
	// Keyed by the collection that *declared* the contract, not by the request's
	// own parent: under the chain rule a sub-collection inherits an ancestor's
	// contract, and the file was picked in that ancestor's Data tab.
	const location = useDataFileStore((s) =>
		contract ? s.locations[contract.collectionId] : undefined
	);

	const [status, setStatus] = useState<SendWithRowStatus>("idle");
	const [parsed, setParsed] = useState<ParsedDataFile | null>(null);
	const [error, setError] = useState<string | null>(null);

	const path = location?.path;
	const fileName = location?.fileName;

	const load = useCallback(() => {
		if (!path) return;
		if (!canReadDeclaredDataFile()) {
			// No Electron, no path to re-read. Said plainly rather than left as a
			// spinner that never resolves.
			setStatus("unavailable");
			setError("Reading the declared data file needs the desktop app.");
			return;
		}
		setStatus("loading");
		setError(null);
		void readDeclaredDataFile(path, { maxRows })
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
	}, [path, fileName, maxRows]);

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
