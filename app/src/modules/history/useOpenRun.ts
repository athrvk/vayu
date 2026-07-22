/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What happens when a run in the history list is clicked.
 *
 * A load run opens its report. A **design** run opens the request builder for
 * the request it ran, with the stored response injected into the response pane
 * - not a second read-only viewer for the same row. The builder already knows
 * how to display a stored design run: that is what it rebuilds on a cold start
 * (`useLastDesignRunQuery` -> `responseFromRunResult` -> `useResponseStore`).
 * This extends "restore the *last* run" to "restore *any* run", and is the
 * model Postman uses - history loads into the builder, there is no third view.
 *
 * The store is written *before* the tab opens, so a newly mounted provider
 * finds the response in its initialiser; a provider already on screen for that
 * request picks it up from the store subscription instead.
 *
 * Two things can leave a design run with no builder to open: `request_id` is
 * optional engine-side (`run.request_id.value_or("none")`), and deleting a
 * request does not cascade to its runs. Both land on the run tab, which renders
 * the response on its own.
 */

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchRequestById, fetchRunReport } from "@/queries";
import { useResponseStore, useTabsStore } from "@/stores";
import { responseFromRunResult } from "@/modules/request-builder/utils/restore-response";
import type { Run } from "@/types";

export function useOpenRun() {
	const queryClient = useQueryClient();
	const openTab = useTabsStore((s) => s.openTab);
	const setResponse = useResponseStore((s) => s.setResponse);
	const [openingRunId, setOpeningRunId] = useState<string | null>(null);

	const openRun = useCallback(
		async (run: Run) => {
			const openReport = () => openTab({ type: "run", entityId: run.id });

			if (run.type !== "design") {
				openReport();
				return;
			}

			setOpeningRunId(run.id);
			try {
				const report = await fetchRunReport(queryClient, run.id);
				const restored = responseFromRunResult(report.results?.[0], run.id);

				if (run.requestId) {
					try {
						// Throws when the request is gone, which is the orphan case
						// a `requestId` alone cannot rule out.
						await fetchRequestById(queryClient, run.requestId);
						if (restored) setResponse(run.requestId, restored);
						openTab({ type: "request", entityId: run.requestId });
						return;
					} catch {
						// Fall through: no request to open, but the run is still
						// worth showing.
					}
				}

				openReport();
			} catch {
				// The report itself is unreachable. The run tab asks for it again
				// and has its own error pane with a retry, which is more useful
				// than swallowing this.
				openReport();
			} finally {
				setOpeningRunId(null);
			}
		},
		[queryClient, openTab, setResponse]
	);

	return { openRun, openingRunId };
}
