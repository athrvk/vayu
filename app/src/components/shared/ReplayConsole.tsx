/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the deferred replay's scripts logged (#3127): the console lines of the
 * post-run replay over the sampled responses, kept whatever the verdict. The
 * lines are the same bounded, distinct sample an inline script row carries, so
 * {@link ElementMessages} draws them, dropped cue included. The heading names
 * the replay and its sample size, because these lines are a few hundred
 * responses' worth, not the run's.
 *
 * One source for both places a replay reports: a single-request run's
 * `testValidation` and a scenario step's `tests`.
 */

import { ElementMessages } from "./ElementMessages";
import { hasReplayConsole, replayPhrase } from "./run-assertions";
import type { RunScenarioStepElementTally } from "@/types/domain";

type ReplayConsoleSource = Pick<RunScenarioStepElementTally, "console" | "consoleDropped">;

export function ReplayConsole({
	source,
	sampled,
	className,
}: {
	source: ReplayConsoleSource | undefined;
	/** Responses the replay ran over (`samplesTested`, or the step's `tests.sampled`). */
	sampled: number | undefined;
	className?: string;
}) {
	if (!source || !hasReplayConsole(source)) return null;
	return (
		<div className={className}>
			<p className="text-xs font-medium text-muted-foreground">
				Console from the {replayPhrase(sampled)}
			</p>
			<ElementMessages element={source} />
		</div>
	);
}
