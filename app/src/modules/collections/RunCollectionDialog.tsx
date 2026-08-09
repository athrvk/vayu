/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RunCollectionDialog
 *
 * Starts a collection run. Two options and nothing else, because the scenario
 * *is* the folder: the sequence is `requests.order` (then, with Recursive,
 * descendant collections by `collections.order`, depth-first), which is the
 * order the sidebar already shows. There is no step list to author here, and
 * inventing one would be a second source of truth for an ordering the tree
 * already owns.
 *
 * The engine resolves the whole plan before it answers, so a collection with no
 * requests, a step that will not compose, or a plan over `maxScenarioSteps` all
 * come back as a `400` with no run created. That message is shown here rather
 * than as a toast: it names the step that failed, which is the thing the user
 * has to go and fix.
 *
 * A data file is the third option (issue #402), and it changes what Iterations
 * means: with rows and no explicit count, the run is one pass per row. The rows
 * ride the payload and are dropped when this dialog unmounts - they are user
 * data of unknown sensitivity, so nothing persists them, here or engine-side.
 */

import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
	Button,
	Input,
	Label,
	Switch,
} from "@/components/ui";
import { Callout } from "@/components/shared";
import { useStartScenarioRunMutation } from "@/queries";
import { useSessionStore, useTabsStore } from "@/stores";
import { scenarioRunService } from "@/services";
import type { Collection } from "@/types";
import DataFilePicker, { type SelectedDataFile } from "./DataFilePicker";

export interface RunCollectionDialogProps {
	/**
	 * The collection to run.
	 *
	 * Non-null, because the caller mounts this component only once a folder has
	 * been chosen and unmounts it when the dialog closes. That mount **is** the
	 * reset: the options start at their defaults every time, where a
	 * always-mounted dialog would carry the previous folder's Recursive and
	 * Iterations over silently, and resetting them in an effect would be a
	 * cascading render for something React already models as identity.
	 */
	collection: Collection;
	onOpenChange: (open: boolean) => void;
}

/** Matches the engine's `iterations` bound: a whole number, 1 or more. */
const MIN_ITERATIONS = 1;

export default function RunCollectionDialog({
	collection,
	onOpenChange,
}: RunCollectionDialogProps) {
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const openTab = useTabsStore((s) => s.openTab);
	const startRun = useStartScenarioRunMutation();

	const [recursive, setRecursive] = useState(false);
	const [iterations, setIterations] = useState("1");
	const [dataFile, setDataFile] = useState<SelectedDataFile | null>(null);
	const [dataFileError, setDataFileError] = useState<string | null>(null);

	/*
	 * Empty is a meaningful value only with a data file: it means "one pass per
	 * row", which is the engine's own default when `iterations` is absent from
	 * the payload. Without a file there is no row count to fall back to, so an
	 * empty field is simply invalid.
	 */
	const iterationsBlank = iterations.trim() === "";
	const explicitIterations = iterationsBlank ? undefined : Number(iterations);
	const iterationsValid =
		explicitIterations === undefined
			? !!dataFile
			: Number.isInteger(explicitIterations) && explicitIterations >= MIN_ITERATIONS;
	const canRun = iterationsValid && !dataFileError;

	/*
	 * Picking a file clears an untouched `1`, so the field shows what the run
	 * will do (one pass per row) instead of quietly contradicting the preview
	 * above it. A count the user typed is theirs and is left alone.
	 */
	const handleSelectDataFile = (next: SelectedDataFile | null) => {
		setDataFile(next);
		if (next && iterations === "1") setIterations("");
		if (!next && iterationsBlank) setIterations("1");
	};

	const handleRun = () => {
		if (!canRun) return;
		startRun.mutate(
			{
				scenario: {
					source: "collection",
					collectionId: collection.id,
					recursive,
					// Omitted, not sent as the row count: the engine resolves the
					// default, and a client that computed its own would be a
					// second copy of a rule only one side can enforce.
					...(explicitIterations !== undefined ? { iterations: explicitIterations } : {}),
					// The parsed rows themselves - the same array the preview
					// showed, never a re-parse.
					...(dataFile ? { data: dataFile.parsed.rows } : {}),
				},
				// The environment the rest of the app sends against - a run that
				// resolved `{{variables}}` against a different one than Send does
				// would be a different request wearing the same name.
				...(activeEnvironmentId ? { environmentId: activeEnvironmentId } : {}),
			},
			{
				onSuccess: ({ runId }) => {
					// Attach before the tab opens: the stream is replayable from
					// offset 0, so nothing is missed either way, and the tab finds
					// the store already pointed at this run.
					scenarioRunService.startMonitoring(runId);
					openTab({ type: "run", entityId: runId });
					onOpenChange(false);
				},
			}
		);
	};

	const error = startRun.error;

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Run {collection.name}</DialogTitle>
					<DialogDescription>
						Every request in this collection runs in order, once per iteration.
						Variables and cookies carry from one step to the next.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-2">
					<div className="flex items-center justify-between gap-4">
						<Label htmlFor="run-collection-recursive" className="leading-snug">
							Include sub-folders
							<span className="block text-xs font-normal text-muted-foreground">
								Descend into nested collections, depth-first.
							</span>
						</Label>
						<Switch
							id="run-collection-recursive"
							checked={recursive}
							onCheckedChange={setRecursive}
						/>
					</div>

					<div className="flex items-center justify-between gap-4">
						<Label htmlFor="run-collection-iterations" className="leading-snug">
							Iterations
							<span className="block text-xs font-normal text-muted-foreground">
								{dataFile
									? "How many times to run the whole sequence. Leave empty for one pass per row."
									: "How many times to run the whole sequence."}
							</span>
						</Label>
						<Input
							id="run-collection-iterations"
							type="number"
							min={MIN_ITERATIONS}
							step={1}
							value={iterations}
							placeholder={dataFile ? String(dataFile.parsed.rows.length) : undefined}
							onChange={(e) => setIterations(e.target.value)}
							className="w-24 shrink-0"
							aria-invalid={!iterationsValid}
						/>
					</div>

					{/* Refused here rather than sent and refused by the engine: a
					    fraction or a 0 is a run nobody asked for, and the user can
					    see what is wrong while the field still has focus. */}
					{!iterationsValid && (
						<Callout severity="blocking" title="Iterations">
							Enter a whole number of 1 or more.
						</Callout>
					)}

					<DataFilePicker
						selected={dataFile}
						onSelect={handleSelectDataFile}
						error={dataFileError}
						onError={setDataFileError}
						iterations={explicitIterations}
						disabled={startRun.isPending}
					/>

					{error && (
						<Callout severity="blocking" title="Could not start the run">
							{error instanceof Error ? error.message : "The engine refused it."}
						</Callout>
					)}
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={startRun.isPending}
					>
						Cancel
					</Button>
					<Button onClick={handleRun} disabled={!canRun || startRun.isPending}>
						{startRun.isPending ? (
							<Loader2 className="w-4 h-4 mr-2 animate-spin" />
						) : (
							<Play className="w-4 h-4 mr-2" />
						)}
						Run
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
