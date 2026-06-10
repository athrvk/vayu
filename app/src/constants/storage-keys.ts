/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Local persistence keys (localStorage + zustand persist names).
 *
 * Renaming a key orphans previously persisted data — treat these as part of
 * the app's storage schema.
 */

export const STORAGE_KEYS = {
	/** "system" | "light" | "dark" theme preference. */
	THEME_SOURCE: "vayu-theme-source",
	/** Resolved color scheme cached for instant paint before electron answers. */
	COLOR_SCHEME: "vayu-color-scheme",
	/** Last-used load test configuration (LoadTestConfigDialog). */
	LAST_LOAD_TEST_CONFIG: "vayu:lastLoadTestConfig",
	/** Zustand persist name for variables UI state. */
	VARIABLES_UI_STORE: "variables-ui-store",
} as const;
