/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A design run that has no request builder to open.
 *
 * Clicking a design run in history normally opens the request builder for the
 * request it ran, with this run's response injected - see `useOpenRun`. Two
 * things can leave a run without one: `request_id` is optional engine-side, and
 * deleting a request does not cascade to its runs. Those land here.
 *
 * This is deliberately a *stub around the builder's own response pane*, not a
 * viewer of its own: it supplies the two context fields `ResponseViewer` reads
 * and renders it. That buys the full set of tabs - Body, Headers, Cookies,
 * Timing, Raw - and, more to the point, means the pane keeps improving in one
 * place. The 180-line second viewer this replaced had drifted into a `trace as
 * any` cast, its own status chip, and its own timing renderer, and it silently
 * dropped the sent request body: it computed it and never rendered it.
 *
 * **If this file grows markup of its own, it has become that viewer again.**
 */

import { useMemo } from "react";
import { FileQuestion } from "lucide-react";
import { EmptyState } from "@/components/shared";
import { RequestBuilderContext } from "@/modules/request-builder/context";
import ResponseViewer from "@/modules/request-builder/components/ResponseViewer";
import { createDefaultRequestState } from "@/modules/request-builder/utils/request-state";
import { responseFromRunResult } from "@/modules/request-builder/utils/restore-response";
import type { RequestBuilderContextValue } from "@/modules/request-builder/types";
import type { RunReport } from "@/types";

const noop = () => {};
const asyncNoop = async () => {};

/**
 * Everything a builder context offers that a stored run cannot: editing,
 * executing, saving, resolving variables. Spelled out rather than cast so that
 * adding a field to the context fails here loudly instead of at runtime.
 */
const READ_ONLY_CONTEXT: Omit<RequestBuilderContextValue, "response"> = {
	request: createDefaultRequestState(),
	setRequest: noop,
	updateField: noop,
	setResponse: noop,
	activeTab: "params",
	setActiveTab: noop,
	isExecuting: false,
	isSaving: false,
	hasUnsavedChanges: false,
	saveStatus: "idle",
	resolveString: (input: string) => input,
	resolveVariables: (input: string) => input,
	getVariable: () => null,
	getAllVariables: () => ({}),
	updateVariable: noop,
	executeRequest: asyncNoop,
	saveRequest: asyncNoop,
	startLoadTest: noop,
};

export interface DesignRunResponseProps {
	report: RunReport;
	runId: string;
}

export default function DesignRunResponse({ report, runId }: DesignRunResponseProps) {
	const response = useMemo(
		() => responseFromRunResult(report.results?.[0], runId),
		[report, runId]
	);

	// `ResponseViewer`'s own empty state invites the user to press Send, which is
	// the one thing this tab cannot do.
	if (!response) {
		return (
			<EmptyState
				className="h-full"
				icon={FileQuestion}
				title="Nothing was recorded for this run"
				description="It finished without capturing the request or the response."
			/>
		);
	}

	const value: RequestBuilderContextValue = { ...READ_ONLY_CONTEXT, response };

	return (
		<div className="flex h-full flex-col">
			<RequestBuilderContext.Provider value={value}>
				<ResponseViewer />
			</RequestBuilderContext.Provider>
		</div>
	);
}
