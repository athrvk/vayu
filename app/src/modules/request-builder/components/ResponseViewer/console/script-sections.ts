/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two scripts and the token each is drawn in: a table, so a third source is one entry and
 * cannot half-land. Beside `ScriptSection.tsx`, not in it: exporting components and a constant
 * table loses Fast Refresh for the file (`react-refresh/only-export-components`, 0.5.0+, exempts
 * only primitive-literal exports).
 */
export const SCRIPT_SECTIONS = {
	pre: { label: "Pre-request script", errorLabel: "Pre-request script error", tone: "running" },
	test: {
		label: "Post-request script",
		errorLabel: "Post-request script error",
		tone: "success",
	},
} as const;

export type ScriptKey = keyof typeof SCRIPT_SECTIONS;
