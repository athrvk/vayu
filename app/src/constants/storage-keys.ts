/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Local persistence keys (localStorage + zustand persist names).
 *
 * Renaming a key orphans previously persisted data - treat these as part of
 * the app's storage schema.
 */

export const STORAGE_KEYS = {
	/** "system" | "light" | "dark" theme preference. Read pre-paint in index.html. */
	THEME_SOURCE: "vayu-theme-source",
	/** Accent color scheme name (sunset/sky/…). Read pre-paint in index.html. */
	COLOR_SCHEME: "vayu-color-scheme",
	/** UI font preference (grotesk/system/mono/custom). Read pre-paint in index.html. */
	UI_FONT: "vayu-ui-font",
	/** Custom UI font family, used when UI_FONT === "custom". Read pre-paint. */
	UI_FONT_CUSTOM: "vayu-ui-font-custom",
	/** Interface scale (compact/default/comfortable). Read pre-paint in index.html. */
	UI_SCALE: "vayu-ui-scale",
	/** Corner roundedness (square/default/rounded). Read pre-paint in index.html. */
	UI_RADIUS: "vayu-ui-radius",
	/** Live dashboard chart retention window (1m/5m/15m/30m/full). */
	LIVE_CHART_WINDOW: "vayu-live-chart-window",
	/** Zustand persist name for renderer-only client settings (editor, charts, auto-save). */
	CLIENT_SETTINGS: "vayu.client-settings",
	/** Last-used load test configuration (LoadTestConfigDialog). */
	LAST_LOAD_TEST_CONFIG: "vayu:lastLoadTestConfig",
	/** Zustand persist name for session state (active environment/collection). */
	SESSION_STORE: "vayu.session",
	/** Zustand persist name for open tabs + active tab. */
	TABS_STORE: "vayu.tabs",
	/** Zustand persist name for shell layout (drawer, context bar, split ratio). */
	LAYOUT_STORE: "vayu.layout",
} as const;
