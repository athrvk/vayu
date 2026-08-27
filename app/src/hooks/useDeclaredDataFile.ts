/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The file a collection's data contract was last run with, re-read from disk
 * (issue #599, through the chain since #729, shared since #1039).
 *
 * Two dialogs start a run that can bind `{{data.*}}`: the Run collection dialog
 * and the load dialog. Both want the same opening state - "the file you
 * declared" rather than an empty picker - and the load dialog shipped without
 * it, so a user who had declared a file on the Data tab re-picked it by hand
 * for every load run of a request in that collection.
 *
 * It is one hook rather than a copy in each dialog because the interesting part
 * is not the read: it is the *four* rules around it, each of which was learned
 * once and would have to be re-learned by a second copy.
 *
 * 1. **The contract's collection, not the caller's.** A request in a
 *    sub-collection is governed by the nearest ancestor that declares a
 *    contract, so the remembered location is filed under `contract.collectionId`
 *    and reading the store at the id the caller passed in finds nothing for
 *    exactly the users the chain walk exists to serve.
 * 2. **One attempt.** The collections query may answer a render *after* the
 *    dialog mounts, so a mount-only effect would read an empty chain and never
 *    look again; the ref keeps what the mount-only spelling was there for -
 *    writing the store while the dialog is open must not yank the user's own
 *    selection back to what was remembered.
 * 3. **The row cap applies to a pre-filled file too** (issue #751), against the
 *    live setting. Without it, the remembered path is the one way past a
 *    refusal the picker makes on every hand-picked file - the file would
 *    pre-fill, preview, and be refused by the engine at Run.
 * 4. **A file that cannot be re-read is a note, never a blocker.** Both runs
 *    are startable without a file, and picking one again is the whole remedy.
 *
 * What this hook deliberately does **not** do is decide anything about the run
 * it is pre-filling. The Run collection dialog turns a pristine `iterations` of
 * `1` into "one pass per row" when a file arrives; that is a fact about the
 * *engine's* default for a collection run, not about the file, and a load run's
 * length is its profile's. So that coupling reaches the dialog through the
 * `onPrefill` callback it supplies - the hook fires the seam and knows nothing
 * about what is on the other side of it, which is what lets the load dialog
 * share the pre-fill and share none of the consequence.
 *
 * It writes nothing to the store either: the Data tab is where a contract is
 * declared, and one run started against a different file is not a
 * redeclaration of it for every run that follows.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataFileStore } from "@/stores";
import { useCollectionsQuery } from "@/queries";
import { resolveDataContract } from "@/lib/data-contract";
import { useDataFileLimits } from "@/hooks/useDataFileLimits";
import { DataFileError } from "@/services/data-files";
import {
	canReadDeclaredDataFile,
	readDeclaredDataFile,
	type DeclaredDataFile,
} from "@/services/data-files/read-declared";
import type { SelectedDataFile } from "@/modules/collections/DataFilePicker";
import type { Collection, DataContractScope } from "@/types";

export interface DeclaredDataFileState {
	/**
	 * The file the run will bind - pre-filled from the declaration, or whatever
	 * the user has picked since. `null` when there is none: no contract, no
	 * remembered location, a read still in flight, a read that failed, or a
	 * selection the user cleared.
	 *
	 * The *selection* lives here rather than in each dialog because the two
	 * would otherwise have to copy the pre-fill into their own state in an
	 * effect - a render-phase write React has no reason to allow, and which
	 * `react-hooks/set-state-in-effect` refuses. One owner, so there is no
	 * second copy to fall out of step with the first.
	 */
	file: SelectedDataFile | null;
	/**
	 * Take the user's pick, or `null` to clear it. The pickers' `onSelect`.
	 *
	 * `SelectedDataFile` rather than `DeclaredDataFile` because a hand-picked
	 * file may have no path at all - a browser, or a drag-and-drop of remote
	 * content - while a re-read one always does. The wider type is the one both
	 * ways in.
	 */
	setFile: (next: SelectedDataFile | null) => void;
	/**
	 * Why the remembered file is not in `file`, in the words the caller renders
	 * in a warning. `null` when nothing went wrong, including the ordinary case
	 * of there being no remembered file at all.
	 */
	note: string | null;
	/** The contract in scope, which every caller also audits the pick against. */
	contract: DataContractScope | undefined;
	/**
	 * Drop the note.
	 *
	 * A file the user picks by hand replaces whatever was pre-filled, so the
	 * note about one that could not be re-read has nothing left to say. It is
	 * the caller that knows a pick happened, and it is this hook that owns the
	 * note - so the dismissal is offered rather than each dialog keeping a
	 * second flag beside a note it cannot reach.
	 */
	dismissNote: () => void;
}

/**
 * Both callers mount only while their dialog is open, so there is no `enabled`
 * gate here: the one attempt is always spent on a render the user can see.
 *
 * @param collectionId The collection the run is scoped to - a request's own
 *        collection is fine, since the contract walk finds the declaring
 *        ancestor from it.
 * @param options.collection The caller's own row for that collection, when it
 *        holds one. It stands *ahead* of the query's copy of itself: the Run
 *        collection dialog is opened with a row and must resolve a contract it
 *        declares even on a render where the collections query has not
 *        answered. Ancestors can only ever come from the query.
 * @param options.onPrefill Called once, with the file, if the pre-fill lands.
 *        This is the seam for what a *caller* concludes from a file arriving,
 *        as opposed to what the file is: the Run collection dialog turns a
 *        pristine `iterations` of `1` into "one pass per row" here, because
 *        that is the engine's default for a collection run. The load dialog
 *        passes nothing - a load run's length is its profile's - which is why
 *        this is a callback the caller supplies rather than behaviour the hook
 *        performs.
 */
export function useDeclaredDataFile(
	collectionId: string | null | undefined,
	options: { collection?: Collection; onPrefill?: (file: DeclaredDataFile) => void } = {}
): DeclaredDataFileState {
	const { collection, onPrefill } = options;
	/*
	 * Held in a ref so a caller may pass an inline closure without it becoming
	 * a dependency of the read below - which would re-run the effect on every
	 * render, and is exactly the shape that turns "once" into "every time".
	 */
	const onPrefillRef = useRef(onPrefill);
	// Synced in an effect, not during render, and declared ahead of the read
	// below so it is current before that one first runs. The read resolves
	// asynchronously in any case, so what it calls is the latest closure.
	useEffect(() => {
		onPrefillRef.current = onPrefill;
	}, [onPrefill]);
	const { data: collections = [] } = useCollectionsQuery();
	/*
	 * `useDataContract` is the plain adapter onto the same walk and is what
	 * every other surface reads; this hook cannot use it, because it is the one
	 * caller that has a row the query may not have yet. The walk itself is
	 * still `resolveDataContract` - the override is the only difference.
	 */
	const chain = useMemo(
		() =>
			collection
				? [collection, ...collections.filter((row) => row.id !== collection.id)]
				: collections,
		[collection, collections]
	);
	const contract = useMemo(
		() => resolveDataContract(collectionId, chain) ?? undefined,
		[collectionId, chain]
	);
	// The store is keyed by the collection that *declares* the contract, which
	// is the whole point of rule 1 above. Falling back to the caller's id keeps
	// a collection that declares its own contract working before the query
	// answers, and finds nothing otherwise - which is the correct answer.
	const declaringCollectionId = contract?.collectionId ?? collectionId ?? "";
	const rememberedFile = useDataFileStore((s) => s.locations[declaringCollectionId]);
	const { maxRows } = useDataFileLimits();

	const [file, setFile] = useState<SelectedDataFile | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const attempted = useRef(false);

	useEffect(() => {
		if (attempted.current) return;
		if (!rememberedFile?.path) return;
		attempted.current = true;
		let cancelled = false;
		// No Electron, no path to re-read - the picker stands, and this is not
		// a failure worth a note: it is a state that will never resolve.
		if (!canReadDeclaredDataFile()) return;

		void readDeclaredDataFile(rememberedFile.path, { maxRows })
			.then((read) => {
				if (cancelled) return;
				setFile(read);
				onPrefillRef.current?.(read);
			})
			.catch((e: unknown) => {
				if (cancelled) return;
				setNote(
					e instanceof DataFileError || e instanceof Error
						? e.message
						: `The declared file is no longer at ${rememberedFile.fileName} - pick it again.`
				);
			});

		return () => {
			cancelled = true;
		};
	}, [rememberedFile, maxRows]);

	const dismissNote = useCallback(() => setNote(null), []);

	return { file, setFile, note, contract, dismissNote };
}
