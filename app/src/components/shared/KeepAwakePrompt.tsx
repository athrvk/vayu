/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one ask, for the one run needing it (#1357). The wake lock is off by default, as overriding
 * the machine's power settings is not the app's decision; but a long run started and walked away
 * from is also where nobody visits settings first. So the app asks then and only then: a run
 * declaring ten minutes or more, with the standing preference off. Mounted once at the root, not at
 * the three start sites: the question is about the live run, which the dashboard store knows, and
 * one mount cannot stack dialogs. A collection run is never asked about: it declares no duration,
 * and a prompt on every run would train dismissal.
 */

import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/ui";
import { isDashboardRunLive, useClientSettingsStore, useDashboardStore } from "@/stores";
import { wakeLock, WAKE_LOCK_KEYS } from "@/services/wake-lock";
import { formatRunLength, isLongRun, runLengthSeconds } from "@/modules/dashboard/utils/keepAwake";

export default function KeepAwakePrompt() {
	const runId = useDashboardStore((s) => s.currentRunId);
	const isLive = useDashboardStore((s) => isDashboardRunLive(s.phase));
	const config = useDashboardStore((s) => s.loadTestConfig);
	const keepAwakeAlways = useClientSettingsStore((s) => s.keepAwakeDuringRuns);

	/**
	 * The run already answered (either button, or dismissing), so a stream restarting under the
	 * same id (a reconnect, the dashboard re-attaching) does not re-ask. State, not an effect:
	 * whether to ask derives during render from what is live and what was said, and an effect
	 * opening the dialog would be a second copy of that answer, a render behind.
	 */
	const [decided, setDecided] = useState<string | null>(null);

	const asking =
		runId !== null && isLive && !keepAwakeAlways && decided !== runId && isLongRun(config);

	const length = runLengthSeconds(config);

	const keepAwake = () => {
		// Under the key the service releases on every terminal path, so the grant ends with the
		// run.
		wakeLock.hold(WAKE_LOCK_KEYS.loadRun, "Load test run streaming (allowed for this run)");
		setDecided(runId);
	};

	return (
		<DeleteConfirmDialog
			open={asking}
			onOpenChange={() => setDecided(runId)}
			title="Keep this machine awake?"
			description={
				<>
					This run is set to last{" "}
					{length === null ? "several minutes" : formatRunLength(length)}. If the machine
					suspends before it ends, the run stops with it and its charts come back with a
					gap.
					<br />
					<br />
					Vayu can ask the system not to sleep until the run finishes. The display still
					dims and locks as usual. To answer this once for every run, use Settings › Load
					testing › Keep the machine awake during runs.
				</>
			}
			confirmLabel="Keep awake"
			cancelLabel="Allow sleep"
			confirmVariant="default"
			onConfirm={keepAwake}
		/>
	);
}
