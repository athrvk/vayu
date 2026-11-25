/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The file a collection's data contract was last run with, re-read from disk (#599; through the
 * chain, #729; shared, #1039).
 *
 * Two dialogs start a run that can bind `{{data.*}}`, the Run collection dialog and the load
 * dialog, and both open on "the file you declared" rather than an empty picker. One hook, not a
 * copy in each dialog, because the interesting part is not the read but the *four* rules around it,
 * each of which a second copy would have to re-learn:
 *
 * 1. **The contract's collection, not the caller's.** A request in a sub-collection is governed by
 *    the nearest ancestor that declares a contract, so the remembered location is filed under
 *    `contract.collectionId`; reading the store at the caller's id finds nothing for exactly the
 *    users the chain walk exists to serve.
 * 2. **One attempt, and none after a pick.** The collections query may answer a render *after* the
 *    dialog mounts, so a mount-only effect would read an empty chain and never look again; the refs
 *    keep what mount-only was for: a store write while the dialog is open, which a pick's own
 *    declare makes, must not yank the user's selection back to what was remembered.
 * 3. **The row cap applies to a pre-filled file too** (#751), against the live setting. Otherwise
 *    the remembered path is the one way past the refusal the picker makes on every hand-picked
 *    file: the file would pre-fill, preview, and be refused by the engine at Run.
 * 4. **A file that cannot be re-read is a note, never a blocker.** Both runs are startable without
 *    a file, and picking one again is the whole remedy.
 *
 * It decides nothing about the run it pre-fills. The Run collection dialog turns a pristine
 * `iterations` of `1` into "one pass per row" when a file arrives; that is a fact about the
 * *engine's* default for a collection run, not about the file, and a load run's length is its
 * profile's. So that coupling reaches the dialog through the `onPrefill` callback it supplies: the
 * hook fires the seam and knows nothing beyond it, which lets the load dialog share the pre-fill
 * and none of the consequence.
 *
 * It declares nothing either (#2050): a pick in a run dialog declares through
 * `useDataContractWriter` against `declaringCollectionId`, and the pre-fill is a read of what was
 * declared, not a pick. The one store write is the read's own: `readDeclaredDataFile` records the
 * hash of the bytes it read against the remembered path (#2051), which is why the read below
 * depends on the location's path, name and reading rather than on the location object.
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
	 * The file the run will bind: pre-filled from the declaration, or whatever the user has picked
	 * since. `null` when there is none: no contract, no remembered location, a read in flight or
	 * failed, or a selection the user cleared.
	 *
	 * The *selection* lives here because otherwise both dialogs would copy the pre-fill into their
	 * own state in an effect, a render-phase write React has no reason to allow and
	 * `react-hooks/set-state-in-effect` refuses. One owner, so no second copy to fall out of step.
	 */
	file: SelectedDataFile | null;
	/**
	 * Take the user's pick, or `null` to clear it (the pickers' `onSelect`). `SelectedDataFile`,
	 * not `DeclaredDataFile`, because a hand-picked file may have no path (a browser, a
	 * drag-and-drop of remote content) while a re-read one always does; the wider type is the one
	 * both ways in.
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
	 * Drop the note. A hand-picked file replaces whatever was pre-filled, so the note about one
	 * that could not be re-read has nothing left to say. The caller knows a pick happened and this
	 * hook owns the note, so the dismissal is offered rather than each dialog keeping a second flag
	 * beside a note it cannot reach.
	 */
	dismissNote: () => void;
	/**
	 * The collection a pick declares for: the one whose contract the run binds against, or the
	 * caller's own when nothing above it declares. Empty for a run scoped to no collection, which
	 * declares nothing.
	 *
	 * Held for the caller's life once a contract has resolved: the picker offers Remove in place of
	 * Choose file, so every swap is Remove (which clears the contract) then a pick, and that pick
	 * re-declares where the cleared contract was, not down at the caller's own collection or up at
	 * an ancestor whose contract the walk now reaches.
	 */
	declaringCollectionId: string;
}

/**
 * Both callers mount only while their dialog is open, so there is no `enabled` gate here: the one
 * attempt is always spent on a render the user can see.
 *
 * @param collectionId The collection the run is scoped to; a request's own collection is fine,
 *        since the contract walk finds the declaring ancestor from it.
 * @param options.collection The caller's own row for that collection, when it holds one. It stands
 *        in for the query's copy only while the query has none: the Run collection dialog opens
 *        with a row and must resolve a contract it declares even on a render where the collections
 *        query has not answered, but the row is a snapshot from the moment the dialog opened, and a
 *        declare made since lands in the query, not in it. Ancestors only ever come from the query.
 * @param options.onPrefill Called once, with the file, if the pre-fill lands: the seam for what a
 *        *caller* concludes from a file arriving, as opposed to what the file is. The Run
 *        collection dialog turns a pristine `iterations` of `1` into "one pass per row" here, the
 *        engine's default for a collection run; the load dialog passes nothing, as a load run's
 *        length is its profile's.
 */
export function useDeclaredDataFile(
	collectionId: string | null | undefined,
	options: { collection?: Collection; onPrefill?: (file: DeclaredDataFile) => void } = {}
): DeclaredDataFileState {
	const { collection, onPrefill } = options;
	/*
	 * Held in a ref so a caller may pass an inline closure without it becoming a dependency of the
	 * read below, which would re-run the effect every render and turn "once" into "every time".
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
	 * `useDataContract` is the plain adapter onto the same walk and what every other surface reads;
	 * this hook cannot use it, being the one caller with a row the query may not have yet. The walk
	 * is still `resolveDataContract`; the override is the only difference.
	 */
	const chain = useMemo(
		() =>
			collection && !collections.some((row) => row.id === collection.id)
				? [collection, ...collections]
				: collections,
		[collection, collections]
	);
	const contract = useMemo(
		() => resolveDataContract(collectionId, chain) ?? undefined,
		[collectionId, chain]
	);
	// The first declarer that resolves, kept for the life of the hook. Only ever
	// set from null: once Remove clears a sub-collection's contract the walk
	// resolves its ancestor's, and following that would make the next pick
	// replace the ancestor's contract. Adjusted during render rather than in an
	// effect, so the render that drops the contract already declares against it.
	const [heldDeclarer, setHeldDeclarer] = useState<string | null>(null);
	if (contract && heldDeclarer === null) {
		setHeldDeclarer(contract.collectionId);
	}
	// The store is keyed by the collection that *declares* the contract, which
	// is the whole point of rule 1 above. Falling back to the caller's id keeps
	// a collection that declares its own contract working before the query
	// answers, and finds nothing otherwise - which is the correct answer.
	const declaringCollectionId = heldDeclarer ?? contract?.collectionId ?? collectionId ?? "";
	const rememberedFile = useDataFileStore((s) => s.locations[declaringCollectionId]);
	// Primitives, not the object: the read's hash record replaces the object,
	// and an object dependency would cancel the very read that replaced it.
	const rememberedPath = rememberedFile?.path;
	const rememberedName = rememberedFile?.fileName;
	const rememberedCastNumbers = rememberedFile?.castNumbers ?? false;
	const { maxRows } = useDataFileLimits();

	const [file, setFile] = useState<SelectedDataFile | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const attempted = useRef(false);
	/*
	 * Once the user has picked (or removed), the pre-fill has nothing left to do. A pick declares,
	 * and the declare writes the store this effect reads, so otherwise a first-time declare
	 * re-reads the picked file over the pick, and a read in flight lands on top of it.
	 */
	const picked = useRef(false);
	const pick = useCallback((next: SelectedDataFile | null) => {
		picked.current = true;
		setFile(next);
	}, []);

	useEffect(() => {
		if (attempted.current || picked.current) return;
		if (!rememberedPath) return;
		attempted.current = true;
		let cancelled = false;
		// No Electron, no path to re-read - the picker stands, and this is not
		// a failure worth a note: it is a state that will never resolve.
		if (!canReadDeclaredDataFile()) return;

		void readDeclaredDataFile(rememberedPath, { maxRows, castNumbers: rememberedCastNumbers })
			.then((read) => {
				if (cancelled || picked.current) return;
				setFile(read);
				onPrefillRef.current?.(read);
			})
			.catch((e: unknown) => {
				if (cancelled || picked.current) return;
				setNote(
					e instanceof DataFileError || e instanceof Error
						? e.message
						: `The declared file is no longer at ${rememberedName} - pick it again.`
				);
			});

		return () => {
			cancelled = true;
		};
	}, [rememberedPath, rememberedName, rememberedCastNumbers, maxRows]);

	const dismissNote = useCallback(() => setNote(null), []);

	return { file, setFile: pick, note, contract, dismissNote, declaringCollectionId };
}
