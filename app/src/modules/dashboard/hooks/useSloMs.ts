/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useClientSettingsStore } from "@/stores";
import type { Breakpoint } from "../utils/computeBreakpoint";

/**
 * The SLO (ms) a run's SLO lines and tiles are drawn at: the one its breakpoint
 * was judged against, so a capacity run keeps its own budget and a stored run
 * the threshold it was judged by after the setting has changed. The Settings SLO
 * is only the answer where no breakpoint carries one.
 */
export function useSloMs(breakpoint: Breakpoint | null | undefined): number {
	const settingSloMs = useClientSettingsStore((s) => s.sloThresholdMs);
	return breakpoint?.sloMs ?? settingSloMs;
}
