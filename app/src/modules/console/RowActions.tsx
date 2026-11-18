/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The controls beside a Console row's summary (#3634), in `SampledExchange`'s
 * `actions` slot so neither sits inside the summary's own button.
 */

import { Copy, ExternalLink } from "lucide-react";
import { Button, TooltipIconButton } from "@/components/ui";
import { useCopy } from "@/hooks/useCopy";
import { formatBytes } from "@/lib/format-number";
import { WITHHELD_MARKER } from "@/lib/withheld-value";
import { CONSOLE_BODY_MAX_CHARS } from "@/stores/console-store";
import { useTabsStore } from "@/stores";
import { consoleRowCurl, curlBodyIsCut, type ConsoleCurlRow } from "./console-curl";

/** What the copy holds, said before it is pasted somewhere a credential would matter. */
function curlTooltip(row: ConsoleCurlRow): string {
	const masked = `Copy as cURL, with credentials as ${WITHHELD_MARKER}`;
	if (!curlBodyIsCut(row)) return masked;
	return `${masked}. The body is cut at ${formatBytes(CONSOLE_BODY_MAX_CHARS)}.`;
}

export function CopyCurlButton({ row }: { row: ConsoleCurlRow }) {
	const { copy } = useCopy();
	return (
		<TooltipIconButton
			type="button"
			label="Copy as cURL"
			tooltip={curlTooltip(row)}
			icon={<Copy className="size-icon-sm" aria-hidden="true" />}
			onClick={() => void copy(consoleRowCurl(row), "cURL command")}
			className="text-muted-foreground hover:text-foreground"
		/>
	);
}

/**
 * The stored run in its own tab, History's view of it, where the trace keeps
 * what the ring cut. "Open run", as the step card's "Open request": a label is
 * sentence case, so it cannot name History the way a sentence does.
 */
export function OpenRunButton({ runId }: { runId: string }) {
	const openTab = useTabsStore((s) => s.openTab);
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			className="h-control-sm gap-1.5 px-2 text-xs"
			onClick={() => openTab({ type: "run", entityId: runId })}
		>
			<ExternalLink aria-hidden="true" className="size-icon-sm" />
			Open run
		</Button>
	);
}
