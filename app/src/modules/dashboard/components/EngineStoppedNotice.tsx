/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The dashboard's notice for a load test whose engine process ended under it (#3605), with the
 * Restart that brings an engine back to serve its report. Its own component, so the hook's query
 * client is needed only where this phase is drawn. Restart shares `useEngineRestart`, and so its
 * one-at-a-time flag, with the Dock and the Settings banner: pressed while either runs, it reads
 * Restarting and does nothing more. Offered only while no engine is serving, as restarting a
 * running engine to load a report would kill the thing it waits on.
 */

import { Callout } from "@/components/shared";
import { Button } from "@/components/ui";
import { useEngineRestart } from "@/hooks/useEngineRestart";
import { useEngineServing } from "@/modules/services/useRunningServices";

export function EngineStoppedNotice() {
	const { restart, isRestarting } = useEngineRestart();
	const serving = useEngineServing();

	return (
		<Callout
			severity="blocking"
			action={
				serving ? undefined : (
					<Button
						variant="outline"
						size="sm"
						onClick={() => void restart()}
						disabled={isRestarting}
					>
						{isRestarting ? "Restarting…" : "Restart"}
					</Button>
				)
			}
		>
			Vayu&apos;s engine stopped while this load test was running, and the test stopped with
			it.
		</Callout>
	);
}
