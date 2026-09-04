/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * KeepAwakePrompt - the one ask, for the one run that needs it (issue #1357).
 *
 * The wake lock is off by default, because an app that quietly overrides the
 * machine's power settings has decided something that is not its to decide. But
 * the case the lock exists for - a long run the user starts and walks away from
 * - is also the case where nobody thinks to visit a settings screen first. So
 * the app asks when the situation arises, and only then: a run that declares
 * ten minutes or more, with the standing preference off.
 *
 * Mounted once, at the app root, rather than at any of the three places a load
 * run can start: the question is about the run that is streaming, and the
 * dashboard store is where that fact lives. One mount also means one dialog -
 * a prompt per start site could stack.
 *
 * A collection run is never asked about. It declares no duration, so nothing
 * here can tell a two-second sequence from a two-hour one, and a prompt on
 * every one of them would train the user to dismiss it.
 */

import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/ui";
import { useClientSettingsStore, useDashboardStore } from "@/stores";
import { wakeLock, WAKE_LOCK_KEYS } from "@/services/wake-lock";
import { formatRunLength, isLongRun, runLengthSeconds } from "@/modules/dashboard/utils/keepAwake";

export default function KeepAwakePrompt() {
	const runId = useDashboardStore((s) => s.currentRunId);
	const isStreaming = useDashboardStore((s) => s.isStreaming);
	const config = useDashboardStore((s) => s.loadTestConfig);
	const keepAwakeAlways = useClientSettingsStore((s) => s.keepAwakeDuringRuns);

	/**
	 * The run the user has already answered about - by either button, or by
	 * dismissing. Held so a stream that stops and starts again under the same id
	 * (a reconnect, or the dashboard re-attaching) does not re-open a question
	 * that was answered.
	 *
	 * State rather than an effect: whether to ask is a function of what is
	 * streaming and what the user has said, so it is derived during render. An
	 * effect that opened the dialog would be a second copy of that answer, one
	 * render behind.
	 */
	const [decided, setDecided] = useState<string | null>(null);

	const asking =
		runId !== null && isStreaming && !keepAwakeAlways && decided !== runId && isLongRun(config);

	const length = runLengthSeconds(config);

	const keepAwake = () => {
		// Held under the same key the service releases on every terminal path, so
		// this grant ends with the run rather than outliving it.
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
					dims and locks as usual. To answer this once for every run, use Settings &gt;
					Load testing &gt; Keep the machine awake during runs.
				</>
			}
			confirmLabel="Keep awake"
			cancelLabel="Allow sleep"
			confirmVariant="default"
			onConfirm={keepAwake}
		/>
	);
}
