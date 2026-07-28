/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { type ReactNode } from "react";
import { EYEBROW_CLASS, InfoChip } from "@/components/ui";

// Re-exported, not redefined - both values live in `components/ui` so every
// surface can reach them, and the dashboard's existing imports still resolve.
//
// `InfoChip` was defined here, where only the dashboard could import it without
// a module reaching into another module. The request-builder therefore grew its
// own copy (`ResponseTimingTab`'s `InfoTip`), and the copy is the one that got
// the `border-rule` fix - so the original never did. It lives in
// `ui/info-chip` now; see that file for why the border stayed a prop.
export { EYEBROW_CLASS, InfoChip };

export function Eyebrow({ children }: { children: ReactNode }) {
	return <p className={EYEBROW_CLASS}>{children}</p>;
}

/** Format a possibly-undefined number, falling back to a dash. */
export function fmt(v: number | undefined, digits = 1): string {
	return v !== undefined ? v.toFixed(digits) : "-";
}
