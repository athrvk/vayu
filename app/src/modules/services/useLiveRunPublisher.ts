/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Tells the main process which run the app shows live, so the close that would stop it can name it
 * beside the services (#3604). The run is the one the run gate holds (`stores/run-gate.ts`), the
 * answer that refuses a second run while it streams; only its kind and label cross, since main
 * names the run and never addresses it.
 *
 * Gated on `useEngineServing`, like the services list: a run whose engine is down is already over,
 * and a close would stop nothing of it.
 */

import { useEffect } from "react";

import { useCanStartLoadRun } from "@/stores";
import { useEngineServing } from "./useRunningServices";

/** Mounted once at the app root, beside `useRunningServicesPublisher`. */
export function useLiveRunPublisher(): void {
	const serving = useEngineServing();
	const gate = useCanStartLoadRun();
	const run = serving && !gate.ok ? gate.running : null;
	// Primitives, so a run moving between live phases publishes nothing new.
	const kind = run?.kind ?? null;
	const label = run?.label ?? null;

	useEffect(() => {
		window.electronAPI?.setLiveRun?.(kind ? { kind, label } : null);
	}, [kind, label]);
}
