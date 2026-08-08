/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How this request last went: the status, how long it took, and when.
 *
 * The chip is `StatusCodeBadge`, the same one the response pane paints - it
 * already carries the `status === 0` branch that reads "ERR" for a connection
 * failure, which a local copy of the twelve lines lost once before.
 */

import { useLastDesignRunQuery } from "@/queries";
import { useRequestQuery } from "@/queries";
import { StatusCodeBadge } from "@/components/shared/response-viewer";
import { formatRelativeTime } from "@/utils/helpers";
import { SectionEmpty, SectionLoading } from "./Section";
import type { ContextBarSectionProps } from "./types";

export function LastResultSection({ tab }: ContextBarSectionProps) {
	const { data: request } = useRequestQuery(tab.entityId);
	const { run, report, isLoading } = useLastDesignRunQuery(request?.id ?? null);

	if (isLoading) return <SectionLoading />;

	// The exchange lives on the report's one result row, not on the list row -
	// the same path the builder's cold-start restore reads.
	const result = report?.results?.[0];
	if (!run || !result) return <SectionEmpty>This request hasn't been sent yet</SectionEmpty>;

	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-2">
				<StatusCodeBadge status={result.statusCode} statusText={result.statusText} />
				<span className="text-xs font-mono text-muted-foreground">
					{Math.round(result.latencyMs)} ms
				</span>
			</div>
			<p className="text-[11px] text-muted-foreground m-0">
				{formatRelativeTime(result.timestamp || run.startTime)}
			</p>
			{result.error && (
				<p className="text-[11px] text-status-error-text m-0 break-words">{result.error}</p>
			)}
		</div>
	);
}
