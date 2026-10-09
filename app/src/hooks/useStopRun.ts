/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState } from "react";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { apiService } from "@/services/api";
import { useToastStore } from "@/stores";

/**
 * Stop a run from a History tab: the request, the cache refresh that follows
 * it, and the toast when it fails. Shared by the collection-run tab and the
 * in-progress load-test pane, which are the two places a tab with no stream of
 * its own can cancel a run (`StopRunButton`).
 *
 * `stop` resolves once the request and the refresh are done and never throws.
 */
export function useStopRun(runId: string): { stop: () => Promise<void>; isStopping: boolean } {
	const showToast = useToastStore((s) => s.showToast);
	const [isStopping, setIsStopping] = useState(false);

	const stop = async (): Promise<void> => {
		setIsStopping(true);
		try {
			await apiService.stopRun(runId);
			/*
			 * A tab attached to the run's stream hears the end again through
			 * `complete`, and its service refreshes these keys on close. A tab that
			 * is *not* attached gets no such event, so without this its run would
			 * sit on "running" - still offering a Stop for something already
			 * stopped, and never loading what the run just wrote.
			 */
			await queryClient.invalidateQueries({ queryKey: queryKeys.runs.detail(runId) });
			await queryClient.invalidateQueries({ queryKey: queryKeys.runs.report(runId) });
			void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
		} catch (error) {
			// The run keeps executing and the button comes back, so without this
			// a click that failed is indistinguishable from one that did nothing.
			console.error("Failed to stop run:", error);
			showToast({
				message:
					error instanceof Error
						? `Couldn't stop the run - ${error.message}`
						: "Couldn't stop the run",
				variant: "error",
				// The run is still sending requests, so the retry is the reason for
				// telling them at all.
				action: {
					label: "Try again",
					altText: "Try stopping the run again",
					onClick: () => void stop(),
				},
			});
		} finally {
			setIsStopping(false);
		}
	};

	return { stop, isStopping };
}
