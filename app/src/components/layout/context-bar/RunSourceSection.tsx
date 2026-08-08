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
 */

import { useRunQuery, useRequestQuery, useEnvironmentsQuery, isRequestNotFound } from "@/queries";
import { useTabsStore } from "@/stores";
import { Button } from "@/components/ui";
import { SectionEmpty, SectionLoading } from "./Section";
import type { ContextBarSectionProps } from "./types";

export function RunSourceSection({ tab }: ContextBarSectionProps) {
	const { data: run, isLoading } = useRunQuery(tab.entityId);
	const { data: request, error: requestError } = useRequestQuery(run?.requestId ?? null);
	const { data: environments = [] } = useEnvironmentsQuery();
	const openTab = useTabsStore((s) => s.openTab);

	if (isLoading && !run) return <SectionLoading />;
	if (!run) return <SectionEmpty>This run is no longer available</SectionEmpty>;

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
			<div className="flex items-center justify-between gap-2">
				<span className="text-[11px] text-muted-foreground shrink-0">Environment</span>
				<span className="text-xs font-mono text-foreground truncate">
					{environmentLabel}
				</span>
			</div>
		</div>
	);
}
