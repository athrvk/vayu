/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How this collection's last run went, and when.
 *
 * The section #377 specced and PR #394 and PR #400 each deferred, for a reason
 * that was true both times and is not any more: a collection's runs were not
 * addressable. `GET /runs` filtered by `requestId`, and a collection run links
 * no request, so the only way to the row was a substring search of every stored
 * snapshot - a scan per open bar. `GET /runs?collectionId=&limit=1` (#422) is
 * that lookup as one indexed-ish server query returning exactly the row shown.
 *
 * **A run outcome, not a run report.** What the row carries is the outcome
 * (status, refined by the step counts a collection run's list row carries,
 * #3496), the size (steps, and passes when there was more than one) and the
 * age - all of it already on the list row, so there is no `GET /runs/:id/report`
 * behind this. Opening the run is what the row is for: the step-by-step result
 * lives in `ScenarioRunView`, and this is the way back to it from the collection
 * you are editing.
 */

import { Button } from "@/components/ui";
import { useLastCollectionRunQuery } from "@/queries";
import { useTabsStore } from "@/stores";
import { TimeValue } from "@/components/shared/TimeValue";
import { TruncatedText } from "@/components/shared/TruncatedText";
import { formatInstant } from "@/lib/time-value";
import { SectionEmpty, SectionLoading } from "./Section";
import { runStatusTone, scenarioSizeLabel } from "./collection-last-run";
import type { ContextBarSectionProps } from "./types";

export function CollectionLastRunSection({ tab }: ContextBarSectionProps) {
	const { data, isLoading } = useLastCollectionRunQuery(tab.entityId);
	const openTab = useTabsStore((s) => s.openTab);

	if (isLoading && !data) return <SectionLoading />;

	const run = data?.data[0];
	if (!run) {
		return <SectionEmpty>This collection has not been run yet</SectionEmpty>;
	}

	const tone = runStatusTone(run);
	const size = scenarioSizeLabel(run);
	// Every part of the row, so what a narrow bar clips is still in its name.
	const name = [
		"Open collection run",
		tone.label.toLowerCase(),
		tone.verdict && `verdict ${tone.verdict}`,
		size,
		formatInstant(run.startTime, "relative"),
	]
		.filter(Boolean)
		.join(", ");

	return (
		<Button
			type="button"
			variant="listRow"
			onClick={() => openTab({ type: "run", entityId: run.id })}
			aria-label={name}
			className="gap-2 px-1 py-1 hover:bg-accent"
		>
			<span className={`text-xs shrink-0 ${tone.className}`}>{tone.label}</span>
			{size ? (
				<TruncatedText className="flex-1 text-xs font-mono tabular-nums text-muted-foreground">
					{size}
				</TruncatedText>
			) : (
				<span className="flex-1" />
			)}
			<TimeValue
				value={run.startTime}
				style="relative"
				className="text-label font-mono text-muted-foreground shrink-0"
			/>
		</Button>
	);
}
