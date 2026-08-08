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

	const parsedIterations = Number(iterations);
	const iterationsValid =
		Number.isInteger(parsedIterations) && parsedIterations >= MIN_ITERATIONS;

	const handleRun = () => {
		if (!iterationsValid) return;
		startRun.mutate(
			{
				scenario: {
					source: "collection",
					collectionId: collection.id,
					recursive,
					iterations: parsedIterations,
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
								How many times to run the whole sequence.
							</span>
						</Label>
						<Input
							id="run-collection-iterations"
							type="number"
							min={MIN_ITERATIONS}
							step={1}
							value={iterations}
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
					<Button onClick={handleRun} disabled={!iterationsValid || startRun.isPending}>
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
