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
	/** "system" | "light" | "dark" theme preference. Read pre-paint in index.html. */
	THEME_SOURCE: "vayu-theme-source",
	/** Accent color scheme name (sunset/sky/…). Read pre-paint in index.html. */
	COLOR_SCHEME: "vayu-color-scheme",
	/** UI font preference (grotesk/system/mono). Read pre-paint in index.html. */
	UI_FONT: "vayu-ui-font",
	/** Interface scale (compact/default/comfortable). Read pre-paint in index.html. */
	UI_SCALE: "vayu-ui-scale",
	/** Corner roundedness (square/default/rounded). Read pre-paint in index.html. */
	UI_RADIUS: "vayu-ui-radius",
	/** Last-used load test configuration (LoadTestConfigDialog). */
	LAST_LOAD_TEST_CONFIG: "vayu:lastLoadTestConfig",
	/** Zustand persist name for session state (active environment/collection). */
	SESSION_STORE: "vayu.session",
	/** Zustand persist name for open tabs + active tab. */
	TABS_STORE: "vayu.tabs",
	/** Zustand persist name for shell layout (drawer, context bar, split ratio). */
	LAYOUT_STORE: "vayu.layout",
} as const;
