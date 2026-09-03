/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two scripts, and the token each is drawn in.
 *
 * A table rather than a prop per colour, so adding a third source is one entry
 * and cannot half-land.
 *
 * It sits beside `ScriptSection.tsx` rather than inside it because a module
 * that exports both components and a constant table loses Fast Refresh for the
 * whole file - `react-refresh/only-export-components` says so from 0.5.0, which
 * only exempts primitive-literal exports.
 */
export const SCRIPT_SECTIONS = {
	pre: { label: "Pre-request Script", errorLabel: "Pre-request Script Error", tone: "running" },
	test: { label: "Test Script", errorLabel: "Test Script Error", tone: "success" },
} as const;

export type ScriptKey = keyof typeof SCRIPT_SECTIONS;
