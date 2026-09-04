/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * App settings catalogue
 *
 * Every individual setting the client panels render, declared as data.
 *
 * The engine half of Settings has always had this: `GET /config` sends one
 * record per setting, so search could index them. The app half had nothing
 * comparable - the panels render their copy inline - so the search index held
 * seven *panel* titles and a user typing "theme", "color" or "font" got no
 * results at all, on a screen where all three exist. This file is the app half
 * of that catalogue.
 *
 * **The catalogue owns the name; the panel owns the prose.** `label` is not a
 * description of the heading, it *is* the heading: every panel renders
 * `appSetting("<anchor>").label` rather than typing the string a second time, so
 * a rename happens once and reaches both the screen and the search result. That
 * is why the labels read as they do on screen ("Font", not "Interface font") -
 * the result row already prints the owning panel underneath, so qualifying the
 * name here would only make search offer a title the panel never shows.
 *
 * The prose stays in the panel, because a panel's copy is not a string: it
 * carries `<Kbd>` chips, live counts and conditional notices, and it says
 * different things in different blocks. So {@link AppSettingDescriptor.searchText}
 * is *not* a copy of it - see the field's own note.
 *
 * `anchor` is the contract with the panel, not a label: the panel renders
 * `data-setting-anchor="<anchor>"` on the block that holds the setting, which
 * is what a search result scrolls to and outlines. `app-settings.drift.test.tsx`
 * renders every panel and fails if a declared anchor is not on screen, or if the
 * block does not print the label declared for it, so neither half can drift.
 */

import type { ClientSettingsCategory } from "@/types";

export interface AppSettingDescriptor {
	/** Unique across panels; also the `data-setting-anchor` the panel renders. */
	anchor: string;
	panel: ClientSettingsCategory;
	/**
	 * The heading the panel prints on this block - the panel reads it from here,
	 * so there is one writer. Guarded by `app-settings.drift.test.tsx`.
	 */
	label: string;
	/**
	 * Match text, not display text: nothing renders this. It exists so a setting
	 * is findable by what it *does*, in one sentence, where the panel's own copy
	 * is markup rather than a string. Write it as a summary of the block, and do
	 * not treat it as the panel's caption - the search result shows the label and
	 * the panel it lives in, never this.
	 */
	searchText: string;
	/**
	 * What a user might type that is in neither the label nor the search text -
	 * "dark mode" for Theme Mode, "accent" for Color Scheme. Not a place to
	 * repeat words the entry already carries.
	 */
	keywords?: readonly string[];
}

export const APP_SETTINGS = [
	// General
	{
		anchor: "updates",
		panel: "general",
		label: "Updates",
		searchText: "The installed version and a manual check for a newer one.",
		keywords: ["version", "upgrade", "release"],
	},
	{
		anchor: "auto-save",
		panel: "general",
		label: "Auto-save",
		searchText:
			"Whether edits to a request are saved after you stop typing, and how long that wait is.",
		keywords: ["save delay", "unsaved"],
	},
	{
		anchor: "data-management",
		panel: "general",
		label: "Data management",
		searchText: "How many runs are stored, and the button that clears the run history.",
		keywords: ["clear history", "delete runs", "database"],
	},
	{
		anchor: "workspace-backup",
		panel: "general",
		label: "Workspace backup",
		searchText:
			"Take a complete copy of the workspace database, and where the snapshot was written.",
		keywords: ["backup", "snapshot", "restore", "export database", "copy"],
	},
	{
		anchor: "cookies",
		panel: "general",
		label: "Cookies",
		searchText:
			"What the engine's cookie jar holds per environment, and the button that empties it.",
		keywords: ["jar", "clear cookies"],
	},
	{
		anchor: "storage-paths",
		panel: "general",
		label: "Storage Paths",
		searchText: "Where the app keeps its data, database and logs on disk.",
		keywords: ["directory", "folder", "location", "logs"],
	},
	{
		anchor: "reset-app-settings",
		panel: "general",
		label: "Reset app settings",
		searchText: "Restore every app preference to its default.",
		keywords: ["defaults", "factory"],
	},

	// Appearance
	{
		anchor: "theme-mode",
		panel: "appearance",
		label: "Theme Mode",
		searchText: "The app's light or dark palette, or following the operating system.",
		keywords: ["dark mode", "light mode", "night"],
	},
	{
		anchor: "color-scheme",
		panel: "appearance",
		label: "Color Scheme",
		searchText: "The accent color used by buttons, highlights and primary UI elements.",
		keywords: ["accent", "colour", "primary"],
	},
	{
		anchor: "ui-font",
		panel: "appearance",
		label: "Font",
		searchText: "The typeface the app itself is drawn in.",
		// "interface" because the block sits under the Interface card, which
		// qualifies it on screen and cannot in a result list.
		keywords: ["interface", "typeface", "family", "sans"],
	},
	{
		anchor: "ui-scale",
		panel: "appearance",
		label: "Scale",
		searchText: "How large the whole interface is drawn.",
		keywords: ["zoom", "size", "bigger", "smaller"],
	},
	{
		anchor: "roundedness",
		panel: "appearance",
		label: "Roundedness",
		searchText: "How rounded the corners of boxes, buttons and inputs are.",
		keywords: ["radius", "corners", "square"],
	},
	{
		anchor: "reduced-motion",
		panel: "appearance",
		label: "Reduced motion",
		searchText: "Minimize animations and transitions across the app.",
		keywords: ["animation", "accessibility"],
	},

	// Editor
	{
		anchor: "code-font",
		panel: "editor",
		label: "Code font",
		searchText: "The monospace typeface used by scripts and request/response bodies.",
		keywords: ["monospace", "typeface", "family"],
	},
	{
		anchor: "editor-font-size",
		panel: "editor",
		label: "Font size",
		searchText: "How large code is drawn in every editor.",
		keywords: ["text size", "zoom"],
	},
	{
		anchor: "tab-width",
		panel: "editor",
		label: "Tab width",
		searchText: "How many spaces a tab occupies in the editors.",
		keywords: ["indent", "spaces"],
	},
	// Three switches, three entries: they were one descriptor labelled "Word
	// wrap, line numbers and minimap", which named no heading on screen and so
	// was the one label nothing could check.
	{
		anchor: "word-wrap",
		panel: "editor",
		label: "Word wrap",
		searchText: "Whether long lines wrap instead of scrolling horizontally.",
	},
	{
		anchor: "line-numbers",
		panel: "editor",
		label: "Line numbers",
		searchText: "Whether the editor gutter numbers every line.",
	},
	{
		anchor: "minimap",
		panel: "editor",
		label: "Minimap",
		searchText: "Whether the code overview is shown on the right edge.",
	},

	// Dashboard
	{
		anchor: "chart-window",
		panel: "dashboard",
		label: "Chart window",
		searchText: "How much recent history the live charts keep before it rolls off.",
		keywords: ["retention", "live"],
	},
	{
		anchor: "chart-granularity",
		panel: "dashboard",
		label: "Chart granularity",
		searchText:
			"Time-bucket width for the charts - finer shows more detail, coarser smooths noise.",
		keywords: ["bucket", "resolution", "smoothing"],
	},
	{
		anchor: "live-refresh",
		panel: "dashboard",
		label: "Live refresh rate",
		searchText: "How often live metrics are committed to the charts during a run.",
		keywords: ["tick", "update", "cpu"],
	},
	{
		anchor: "slo-threshold",
		panel: "dashboard",
		label: "SLO threshold",
		searchText: "The p99 latency at which a run is considered saturated.",
		keywords: ["capacity", "breakpoint", "saturation", "budget"],
	},

	// Load testing
	{
		anchor: "load-keep-awake",
		panel: "load-testing",
		label: "Keep the machine awake during runs",
		searchText:
			"Ask the operating system not to suspend the machine while a load or collection run is streaming.",
		keywords: ["sleep", "suspend", "power", "wake lock", "idle", "battery"],
	},
	{
		anchor: "load-max-connections",
		panel: "load-testing",
		label: "Max connections",
		searchText: "The largest Connections value the load-test dialog will offer.",
		keywords: ["concurrency", "ceiling", "limit"],
	},
	{
		anchor: "load-max-rate",
		panel: "load-testing",
		label: "Max target rate",
		searchText:
			"The largest Target rate the load-test dialog will offer for Constant RPS runs.",
		keywords: ["rps", "ceiling", "limit"],
	},
	{
		anchor: "load-max-duration",
		panel: "load-testing",
		label: "Max duration",
		searchText: "The longest Duration and Ramp duration the load-test dialog will offer.",
		keywords: ["time", "ceiling", "limit"],
	},
	{
		anchor: "load-max-requests",
		panel: "load-testing",
		label: "Max requests",
		searchText: "The largest Requests value the dialog will offer for Fixed Iterations runs.",
		keywords: ["iterations", "ceiling", "limit"],
	},

	// Notifications
	{
		anchor: "system-notifications",
		panel: "notifications",
		label: "Notify through the system when Vayu is in the background",
		searchText:
			"Post an operating-system notification when a run finishes, the engine stops responding, an update is ready or a sign-in completes while Vayu is not the window in front.",
		keywords: ["os", "desktop", "system", "background", "banner", "alert"],
	},
	{
		anchor: "toast-position",
		panel: "notifications",
		label: "Position",
		searchText: "Which corner or edge notifications appear at.",
		keywords: ["toast", "corner", "placement"],
	},
	{
		anchor: "toast-duration",
		panel: "notifications",
		label: "Duration",
		searchText: "How long notifications stay on screen before they dismiss themselves.",
		keywords: ["toast", "timeout", "linger"],
	},
	{
		anchor: "toast-stack",
		panel: "notifications",
		label: "Stack size",
		searchText: "How many notifications may stack before the oldest is dropped.",
		keywords: ["toast", "queue", "limit"],
	},
	{
		anchor: "toast-severity",
		panel: "notifications",
		label: "Show",
		searchText: "The least severe notification worth interrupting you for.",
		// "severity floor" because the search text says "severe" and the heading
		// says neither - the word a user types for this is in no rendered string.
		keywords: ["toast", "severity floor", "mute", "quiet"],
	},

	// MCP
	{
		anchor: "mcp-connection",
		panel: "mcp",
		label: "Connection",
		searchText:
			"Whether agents can reach Vayu, the endpoint they connect to, and the one-command setup.",
		keywords: ["mcp server", "claude code", "cursor", "codex", "agent", "endpoint"],
	},
	{
		anchor: "mcp-tools",
		panel: "mcp",
		label: "Tools",
		searchText: "Which tools agents may use, by group or one at a time.",
		keywords: ["mcp", "agent", "disable tool"],
	},
	{
		anchor: "mcp-allowlist",
		panel: "mcp",
		label: "Target allowlist",
		searchText: "The hosts an agent is permitted to send traffic to.",
		keywords: ["hosts", "safety", "allow all"],
	},
	{
		anchor: "mcp-caps",
		panel: "mcp",
		label: "Load caps",
		searchText: "Hard ceilings on the load runs an agent may start.",
		keywords: ["safety", "rps", "concurrency", "iterations"],
	},
	{
		anchor: "mcp-writes",
		panel: "mcp",
		label: "Write access",
		searchText: "Whether agents may change saved requests, environments and engine config.",
		keywords: ["read-only", "safety", "permission"],
	},
	// Keyboard shortcuts
	{
		anchor: "keyboard-shortcuts",
		panel: "shortcuts",
		label: "Keyboard shortcuts",
		searchText:
			"Every chord the app listens for, listed for this platform - send, save, close tab, the drawer views and the tab digits.",
		keywords: ["hotkey", "keybinding", "chord", "accelerator", "cheat sheet"],
	},
] as const satisfies readonly AppSettingDescriptor[];

/**
 * The declared anchors, as a union - so a panel asking for a setting that was
 * renamed or removed is a type error rather than a blank heading.
 */
export type AppSettingAnchor = (typeof APP_SETTINGS)[number]["anchor"];

/** The descriptor a panel renders its heading from. */
export function appSetting(anchor: AppSettingAnchor): AppSettingDescriptor {
	const found = APP_SETTINGS.find((setting) => setting.anchor === anchor);
	// Unreachable through the union above; a runtime throw rather than a silent
	// fallback so a catalogue reached some other way (a cast, a JS caller) fails
	// where the mistake is instead of rendering an empty heading.
	if (!found) throw new Error(`No app setting declared for anchor "${anchor}"`);
	return found;
}
