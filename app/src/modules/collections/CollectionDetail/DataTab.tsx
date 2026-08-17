/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DataTab - where a collection declares which columns its data files carry
 * (issue #599, phase 1 of #598).
 *
 * The problem it exists for: a data file is picked in the Run dialog, parsed,
 * sent and forgotten, so at *authoring* time - exactly when someone writes
 * `{{data.email}}` - nothing in the app knows that column exists. Declaring the
 * contract here is what later lets the builder validate and complete those
 * tokens, and what lets the engine's no-data refusal name the columns a run
 * needs.
 *
 * Two halves, stored in two places on purpose:
 *
 * - **The schema** (`dataSchema` on the collection) is the same on every
 *   machine, so it rides the engine row and travels through import.
 * - **The file's path** is true of one filesystem only, so it lives in
 *   `data-file-store` and never reaches the engine.
 *
 * And the thing neither half holds: **rows**. The preview below is in memory
 * for as long as the tab is open, and nothing writes it anywhere.
 *
 * Which is why opening the tab re-reads the remembered file (issue #727) rather
 * than waiting to be handed one: the comparison this tab exists for needs the
 * file *as it is on disk now*, and the only thing stored is where it was. The
 * Run dialog and Send-with-row already re-read the same path, so a tab that
 * asked for a manual re-pick was the one surface unable to answer its own
 * question.
 *
 * Saves are explicit - Declare and Clear - rather than autosaved, because
 * declaring a contract is a statement about the collection, not a keystroke.
 * That is also why this tab is absent from `TABS_HOLDING_DRAFTS`: it holds no
 * draft to survive a switch away.
 */

import { useEffect, useState } from "react";
import { Check, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui";
import { Callout } from "@/components/shared";
import { useUpdateCollectionMutation } from "@/queries/collections";
import { useDataFileStore } from "@/stores";
import { DataFileError, describeDataSchemaDiff } from "@/services/data-files";
import { canReadDeclaredDataFile, readDeclaredDataFile } from "@/services/data-files/read-declared";
import { hasDataContract, type Collection } from "@/types";
import DataFilePicker, { type SelectedDataFile } from "../DataFilePicker";
import ColumnAudit from "./ColumnAudit";
import { InfoBanner, SaveFailed, SectionLabel } from "./shared";

interface DataTabProps {
	collection: Collection;
}

/**
 * Whether opening this collection's tab will re-read a remembered file.
 *
 * Asked *before* the first paint as well as inside the effect, which is the
 * point: the read starts one tick after mount, and a `reading` flag that only
 * became true then would flash "Nothing to compare yet" over a file that is
 * about to arrive - the same incoherence issue #727 is about, one frame long.
 */
function willReadRemembered(collection: Collection): boolean {
	return (
		hasDataContract(collection.dataSchema) &&
		!!useDataFileStore.getState().locations[collection.id]?.path &&
		// Outside Electron there is no path to re-read and never will be, so the
		// picker simply stands - a spinner here would never resolve.
		canReadDeclaredDataFile()
	);
}

export default function DataTab({ collection }: DataTabProps) {
	const [file, setFile] = useState<SelectedDataFile | null>(null);
	const [fileError, setFileError] = useState<string | null>(null);
	/** The remembered file is being opened. Not the same as "no file yet". */
	const [reading, setReading] = useState(() => willReadRemembered(collection));
	/**
	 * Why the remembered file could not be re-read - moved, renamed, or no longer
	 * parsing. Kept apart from `fileError`, which is a refusal of a file the user
	 * just picked: this one leaves the picker empty and usable, because picking
	 * the file again is the whole fix.
	 */
	const [readFailure, setReadFailure] = useState<string | null>(null);
	const updateCollection = useUpdateCollectionMutation();
	const setDataFile = useDataFileStore((s) => s.setDataFile);
	const clearDataFile = useDataFileStore((s) => s.clearDataFile);
	const remembered = useDataFileStore((s) => s.locations[collection.id]);

	const declared = collection.dataSchema?.columns ?? [];
	const declaredContract = hasDataContract(collection.dataSchema);

	/**
	 * Open the remembered file when the tab appears.
	 *
	 * Part of mount, which is what the `key` on this component in
	 * `CollectionDetail` makes sufficient: a different collection is a different
	 * DataTab, so there is no stale file, error or note to clear here.
	 *
	 * Deliberately not re-run when the store changes. `remembered` is written by
	 * Declare and Clear below, and re-reading on it would re-read the file the
	 * user just declared *from* - and would replace a file they had picked by hand
	 * since. The store is therefore read here for what it held on mount; the
	 * reactive value above is for the name the render shows.
	 *
	 * Only with a contract: without one there is nothing to compare a file
	 * against, and the store should hold no path either (Clear takes it with it),
	 * so a read would be work in service of no question.
	 */
	useEffect(() => {
		const path = useDataFileStore.getState().locations[collection.id]?.path;
		if (!willReadRemembered(collection) || !path) return;

		let cancelled = false;
		void readDeclaredDataFile(path)
			.then((read) => {
				if (cancelled) return;
				// `?? read`: a file the user picked while this was in flight is
				// their answer, not a race for the remembered one to win.
				setFile((current) => current ?? read);
				setReading(false);
			})
			.catch((e: unknown) => {
				if (cancelled) return;
				setReading(false);
				setReadFailure(
					e instanceof DataFileError || e instanceof Error
						? e.message
						: "The declared file could not be read - pick it again to compare."
				);
			});

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design; see above.
	}, []);

	// Both directions of file-versus-contract, in the picker's warnings slot.
	// Only meaningful once there is a contract *and* a file - before that, one
	// side of the comparison does not exist.
	const diff = file ? describeDataSchemaDiff(declared, file.parsed.columns) : [];

	const handleDeclare = () => {
		if (!file) return;
		updateCollection.mutate(
			{
				id: collection.id,
				dataSchema: {
					columns: file.parsed.columns,
					declaredAt: Date.now(),
					fileName: file.fileName,
				},
			},
			{
				onSuccess: () => {
					// Remembered only after the contract is stored: a path pointing
					// at a file whose columns were never declared would pre-fill the
					// Run dialog with a file nothing can be checked against.
					if (file.path) {
						setDataFile(collection.id, { path: file.path, fileName: file.fileName });
					}
				},
			}
		);
	};

	const handleClear = () => {
		// `null`, not `{}`: the engine reads absent as "keep" and null as "reset
		// to the default", and the default is no contract. The remembered path
		// goes with it - a file remembered for a collection that declares nothing
		// would pre-fill a run with a file the user has stopped asserting is the
		// right one.
		updateCollection.mutate(
			{ id: collection.id, dataSchema: null },
			{ onSuccess: () => clearDataFile(collection.id) }
		);
	};

	return (
		<div className="max-w-[720px] flex flex-col gap-4">
			<InfoBanner>
				Declare which columns this collection&apos;s data files carry, so{" "}
				<code className="font-mono text-[11px] bg-accent px-1 rounded-sm">{`{{data.column}}`}</code>{" "}
				and{" "}
				<code className="font-mono text-[11px] bg-accent px-1 rounded-sm">
					pm.iterationData
				</code>{" "}
				can be checked before a run. The columns are saved with the collection; the file
				stays on this machine and its rows are never saved anywhere.
			</InfoBanner>

			<div>
				<SectionLabel>Declared columns</SectionLabel>
				{declaredContract ? (
					<div className="rounded-md border border-rule bg-card surface-card p-3 space-y-2">
						<div className="flex flex-wrap gap-1.5">
							{declared.map((column) => (
								<code
									key={column}
									className="rounded-sm bg-accent px-1.5 py-0.5 font-mono text-[11px]"
								>
									{column}
								</code>
							))}
						</div>
						{collection.dataSchema?.fileName && (
							<p className="text-xs text-muted-foreground">
								Declared from{" "}
								{/* Struck through, not replaced by an error: the name is
								    still what the contract was read from, and the file
								    being unreachable is a note beside it rather than a
								    wall in place of it. */}
								<span className={readFailure ? "line-through" : undefined}>
									{collection.dataSchema.fileName}
								</span>
								.{readFailure && ` ${readFailure}`}
							</p>
						)}
					</div>
				) : (
					<p className="text-xs text-muted-foreground">
						No contract yet. Pick a file below and declare its columns.
					</p>
				)}
			</div>

			<DataFilePicker
				selected={file}
				onSelect={setFile}
				error={fileError}
				onError={setFileError}
				iterations={undefined}
				mode="declare"
				additionalWarnings={diff}
				disabled={updateCollection.isPending}
			/>

			<SaveFailed mutation={updateCollection} what="the data contract" />

			<div className="flex items-center gap-2">
				<Button onClick={handleDeclare} disabled={!file || updateCollection.isPending}>
					{updateCollection.isPending ? (
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
					) : (
						<Check className="mr-2 h-4 w-4" />
					)}
					{declaredContract ? "Re-declare from this file" : "Declare columns"}
				</Button>
				{declaredContract && (
					<Button
						variant="outline"
						onClick={handleClear}
						disabled={updateCollection.isPending}
					>
						<Trash2 className="mr-2 h-4 w-4" />
						Clear
					</Button>
				)}
			</div>

			{/*
			 * The audit needs no file - it compares the contract to the requests -
			 * so it sits below the picker rather than inside it, and only once
			 * there is a contract to compare against.
			 */}
			{declaredContract && <ColumnAudit collection={collection} />}

			{/*
			 * Three states, and the point of separating them is that the third used
			 * to swallow the first two: a remembered file being read is not
			 * "nothing to compare", and neither is one this tab has already read.
			 */}
			{declaredContract && !file && reading && (
				<p className="flex items-center gap-2 text-xs text-muted-foreground">
					<Loader2 className="h-3.5 w-3.5 animate-spin" />
					Reading {remembered?.fileName ?? "the declared file"}…
				</p>
			)}

			{declaredContract && !file && !reading && (
				<Callout severity="info" title="Nothing to compare yet">
					Pick a file to see how it lines up against the declared columns.
				</Callout>
			)}
		</div>
	);
}
