/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Local persistence keys (localStorage and zustand persist names). Part of the app's storage
 * schema: renaming a key orphans the data persisted under it.
 */

export const STORAGE_KEYS = {
	/** "system" | "light" | "dark" theme preference. Read pre-paint in index.html. */
	THEME_SOURCE: "vayu-theme-source",
	/** Accent color scheme name (sunset/sky/…). Read pre-paint in index.html. */
	COLOR_SCHEME: "vayu-color-scheme",
	/** Whether to match OS system accent color (Windows/macOS only). */
	MATCH_SYSTEM_ACCENT: "vayu-match-system-accent",
	/** Last accent scheme the OS reported, kept apart from the manual pick. Read pre-paint in index.html. */
	SYSTEM_ACCENT: "vayu-system-accent",
	/** UI font preference (grotesk/inter/system/mono/custom). Read pre-paint in index.html. */
	UI_FONT: "vayu-ui-font",
	/** Custom UI font family, used when UI_FONT === "custom". Read pre-paint. */
	UI_FONT_CUSTOM: "vayu-ui-font-custom",
	/** Interface scale (compact/default/comfortable). Read pre-paint in index.html. */
	UI_SCALE: "vayu-ui-scale",
	/** Corner roundedness (square/default/rounded). Read pre-paint in index.html. */
	UI_RADIUS: "vayu-ui-radius",
	/** Interface density (default/comfortable). Read pre-paint in index.html. */
	UI_DENSITY: "vayu-ui-density",
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
	/**
	 * Persist name for the startup-recovery notice already seen (#922): one timestamp, as the
	 * engine keeps the record itself.
	 */
	RECOVERY_NOTICE_STORE: "vayu.recovery-notice",
	/**
	 * Persist name for the intervals the host slept under a run (#1357), keyed by run id. The
	 * engine's report cannot carry them: the engine was suspended too.
	 */
	HOST_SLEEP_STORE: "vayu.host-sleeps",
	/**
	 * Persist name for which inboxes may notify on a capture (#1388), keyed by inbox id. The
	 * engine's inbox record is in-memory with no field for a client-side preference; an id it no
	 * longer lists is pruned on the next list read.
	 */
	INBOX_NOTIFY_STORE: "vayu.inbox-notify",
} as const;

/**
 * Keys an older Vayu wrote and this one only reads, once: each collection's spec-file and data-file
 * binding from before the binding rode the engine row (#2765). `useLegacyFileBindingImport` moves
 * what they hold onto the rows and removes each key; nothing writes them. Retired with the import
 * (#2809), beside the `file:` origin hand-off (#2763).
 */
export const LEGACY_FILE_BINDING_KEYS = {
	SPEC_FILES: "vayu.spec-files",
	DATA_FILES: "vayu.data-files",
} as const;
