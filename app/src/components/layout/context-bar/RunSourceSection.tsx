/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where this run came from: the request that was sent, and the environment it
 * was sent with.
 *
 * Both are stored on the run and neither had a reader anywhere in the app -
 * `Run.environmentId` in particular was written by every send and displayed by
 * nothing, so a run measured against Staging looked exactly like one measured
 * against Production. It is the first question asked of a result that surprises
 * you, and the run tab could not answer it.
 *
 * The request link opens the tab rather than navigating in place: a run is
 * often opened to compare against the request as it is now, and closing the run
 * to look would lose the comparison.
 *
 * A **collection run** has no `requestId` at all - its source is the folder -
 * so the request row read "Not saved" for it, which is true of the field and
 * wrong about the run. It gets the collection instead, linked the same way and
 * for the same reason.
 */

import {
	useRunQuery,
	useRequestQuery,
	useEnvironmentsQuery,
	useCollectionsQuery,
	isRequestNotFound,
} from "@/queries";
import { useTabsStore } from "@/stores";
import { Button } from "@/components/ui";
import { SectionEmpty, SectionLoading } from "./Section";
import { scenarioFromSnapshot } from "./run-scenario";
import type { ContextBarSectionProps } from "./types";

export function RunSourceSection({ tab }: ContextBarSectionProps) {
	const { data: run, isLoading } = useRunQuery(tab.entityId);
	const { data: request, error: requestError } = useRequestQuery(run?.requestId ?? null);
	const { data: environments = [] } = useEnvironmentsQuery();
	const { data: collections = [] } = useCollectionsQuery();
	const openTab = useTabsStore((s) => s.openTab);

	if (isLoading && !run) return <SectionLoading />;
	if (!run) return <SectionEmpty>This run is no longer available</SectionEmpty>;

	const scenario = scenarioFromSnapshot(run);
	const collectionId = scenario?.collectionId ?? null;
	const collection = collectionId ? collections.find((c) => c.id === collectionId) : undefined;

	const environmentId = run.environmentId ?? null;
	const environment = environmentId
		? environments.find((e) => e.id === environmentId)
		: undefined;
	// A deleted environment is not the same answer as "none was active", and the
	// run kept the id either way - so say which of the two it is rather than
	// folding both into "No environment".
	const environmentLabel = !environmentId
		? "No environment"
		: (environment?.name ?? `${environmentId} (deleted)`);

	const requestGone = isRequestNotFound(requestError);

	return (
		<div className="space-y-2">
			{scenario ? (
				<div className="flex items-center justify-between gap-2">
					<span className="text-[11px] text-muted-foreground shrink-0">Collection</span>
					{!collectionId ? (
						<span className="text-xs text-muted-foreground truncate">Not recorded</span>
					) : !collection ? (
						// The same distinction the environment row draws below: the
						// run kept the id, so "deleted" is a different answer from
						// "there was none", and both beat a blank.
						<span className="text-xs font-mono text-muted-foreground truncate">
							{collectionId} (deleted)
						</span>
					) : (
						<Button
							variant="ghost"
							size="sm"
							className="h-6 text-xs min-w-0 max-w-full"
							onClick={() => openTab({ type: "collection", entityId: collectionId })}
						>
							<span className="truncate">{collection.name}</span>
						</Button>
					)}
				</div>
			) : (
				<div className="flex items-center justify-between gap-2">
					<span className="text-[11px] text-muted-foreground shrink-0">Request</span>
					{!run.requestId ? (
						<span className="text-xs text-muted-foreground truncate">Not saved</span>
					) : requestGone ? (
						<span className="text-xs text-muted-foreground truncate">Deleted</span>
					) : (
						<Button
							variant="ghost"
							size="sm"
							className="h-6 text-xs min-w-0 max-w-full"
							onClick={() => openTab({ type: "request", entityId: run.requestId! })}
						>
							<span className="truncate">{request?.name || "Open request"}</span>
						</Button>
					)}
				</div>
			)}
			<div className="flex items-center justify-between gap-2">
				<span className="text-[11px] text-muted-foreground shrink-0">Environment</span>
				<span className="text-xs font-mono text-foreground truncate">
					{environmentLabel}
				</span>
			</div>
		</div>
	);
}
