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
 * `anchor` is the contract with the panel, not a label: the panel renders
 * `data-setting-anchor="<anchor>"` on the block that holds the setting, which
 * is what a search result scrolls to and outlines. `app-settings.drift.test.tsx`
 * renders every panel and fails if a declared anchor is not on screen, so a
 * setting that is renamed, moved or removed cannot leave a result pointing at
 * nothing.
 */

import type { ClientSettingsCategory } from "@/types";

export interface AppSettingDescriptor {
	/** Unique across panels; also the `data-setting-anchor` the panel renders. */
	anchor: string;
	panel: ClientSettingsCategory;
	label: string;
	description: string;
	/**
	 * What a user might type that is in neither the label nor the description -
	 * "dark mode" for Theme Mode, "accent" for Color Scheme. Not a place to
	 * repeat words the entry already carries.
	 */
	keywords?: readonly string[];
}

export const APP_SETTINGS: readonly AppSettingDescriptor[] = [
	// General
	{
		anchor: "updates",
		panel: "general",
		label: "Updates",
		description: "The installed version and a manual check for a newer one.",
		keywords: ["version", "upgrade", "release"],
	},
	{
		anchor: "auto-save",
		panel: "general",
		label: "Auto-save",
		description:
			"Whether edits to a request are saved after you stop typing, and how long that wait is.",
		keywords: ["save delay", "unsaved"],
	},
	{
		anchor: "data-management",
		panel: "general",
		label: "Data management",
		description: "How many runs are stored, and the button that clears the run history.",
		keywords: ["clear history", "delete runs", "database"],
	},
	{
		anchor: "cookies",
		panel: "general",
		label: "Cookies",
		description:
			"What the engine's cookie jar holds per environment, and the button that empties it.",
		keywords: ["jar", "clear cookies"],
	},
	{
		anchor: "storage-paths",
		panel: "general",
		label: "Storage Paths",
		description: "Where the app keeps its data, database and logs on disk.",
		keywords: ["directory", "folder", "location", "logs"],
	},
	{
		anchor: "reset-app-settings",
		panel: "general",
		label: "Reset app settings",
		description: "Restore every app preference to its default.",
		keywords: ["defaults", "factory"],
	},

	// Appearance
	{
		anchor: "theme-mode",
		panel: "appearance",
		label: "Theme Mode",
		description: "The app's light or dark palette, or following the operating system.",
		keywords: ["dark mode", "light mode", "night"],
	},
	{
		anchor: "color-scheme",
		panel: "appearance",
		label: "Color Scheme",
		description: "The accent color used by buttons, highlights and primary UI elements.",
		keywords: ["accent", "colour", "primary"],
	},
	{
		anchor: "ui-font",
		panel: "appearance",
		label: "Interface font",
		description: "The typeface the app itself is drawn in.",
		keywords: ["typeface", "family", "sans"],
	},
	{
		anchor: "ui-scale",
		panel: "appearance",
		label: "Interface scale",
		description: "How large the whole interface is drawn.",
		keywords: ["zoom", "size", "bigger", "smaller"],
	},
	{
		anchor: "roundedness",
		panel: "appearance",
		label: "Roundedness",
		description: "How rounded the corners of boxes, buttons and inputs are.",
		keywords: ["radius", "corners", "square"],
	},
	{
		anchor: "reduced-motion",
		panel: "appearance",
		label: "Reduced motion",
		description: "Minimize animations and transitions across the app.",
		keywords: ["animation", "accessibility"],
	},

	// Editor
	{
		anchor: "code-font",
		panel: "editor",
		label: "Code font",
		description: "The monospace typeface used by scripts and request/response bodies.",
		keywords: ["monospace", "typeface", "family"],
	},
	{
		anchor: "editor-font-size",
		panel: "editor",
		label: "Font size",
		description: "How large code is drawn in every editor.",
		keywords: ["text size", "zoom"],
	},
	{
		anchor: "tab-width",
		panel: "editor",
		label: "Tab width",
		description: "How many spaces a tab occupies in the editors.",
		keywords: ["indent", "spaces"],
	},
	{
		anchor: "editor-behaviour",
		panel: "editor",
		label: "Word wrap, line numbers and minimap",
		description:
			"Whether long lines wrap, the gutter numbers lines, and the code overview is shown.",
		keywords: ["gutter", "overview", "wrap"],
	},

	// Dashboard
	{
		anchor: "chart-window",
		panel: "dashboard",
		label: "Chart window",
		description: "How much recent history the live charts keep before it rolls off.",
		keywords: ["retention", "live"],
	},
	{
		anchor: "chart-granularity",
		panel: "dashboard",
		label: "Chart granularity",
		description:
			"Time-bucket width for the charts - finer shows more detail, coarser smooths noise.",
		keywords: ["bucket", "resolution", "smoothing"],
	},
	{
		anchor: "live-refresh",
		panel: "dashboard",
		label: "Live refresh rate",
		description: "How often live metrics are committed to the charts during a run.",
		keywords: ["tick", "update", "cpu"],
	},
	{
		anchor: "slo-threshold",
		panel: "dashboard",
		label: "SLO threshold",
		description: "The p99 latency at which a run is considered saturated.",
		keywords: ["capacity", "breakpoint", "saturation", "budget"],
	},

	// Load testing
	{
		anchor: "load-max-connections",
		panel: "load-testing",
		label: "Max connections",
		description: "The largest Connections value the load-test dialog will offer.",
		keywords: ["concurrency", "ceiling", "limit"],
	},
	{
		anchor: "load-max-rate",
		panel: "load-testing",
		label: "Max target rate",
		description:
			"The largest Target rate the load-test dialog will offer for Constant RPS runs.",
		keywords: ["rps", "ceiling", "limit"],
	},
	{
		anchor: "load-max-duration",
		panel: "load-testing",
		label: "Max duration",
		description: "The longest Duration and Ramp duration the load-test dialog will offer.",
		keywords: ["time", "ceiling", "limit"],
	},
	{
		anchor: "load-max-requests",
		panel: "load-testing",
		label: "Max requests",
		description: "The largest Requests value the dialog will offer for Fixed Iterations runs.",
		keywords: ["iterations", "ceiling", "limit"],
	},

	// Notifications
	{
		anchor: "toast-position",
		panel: "notifications",
		label: "Notification position",
		description: "Which corner or edge notifications appear at.",
		keywords: ["toast", "corner", "placement"],
	},
	{
		anchor: "toast-duration",
		panel: "notifications",
		label: "Notification duration",
		description: "How long notifications stay on screen before they dismiss themselves.",
		keywords: ["toast", "timeout", "linger"],
	},
	{
		anchor: "toast-stack",
		panel: "notifications",
		label: "Notification stack size",
		description: "How many notifications may stack before the oldest is dropped.",
		keywords: ["toast", "queue", "limit"],
	},
	{
		anchor: "toast-severity",
		panel: "notifications",
		label: "Notification severity floor",
		description: "The least severe notification worth interrupting you for.",
		keywords: ["toast", "mute", "quiet", "show"],
	},

	// MCP
	{
		anchor: "mcp-connection",
		panel: "mcp",
		label: "MCP server",
		description:
			"Whether agents can reach Vayu, the endpoint they connect to, and the one-command setup.",
		keywords: ["claude code", "cursor", "codex", "agent", "endpoint"],
	},
	{
		anchor: "mcp-tools",
		panel: "mcp",
		label: "MCP tools",
		description: "Which tools agents may use, by group or one at a time.",
		keywords: ["agent", "disable tool"],
	},
	{
		anchor: "mcp-allowlist",
		panel: "mcp",
		label: "Target allowlist",
		description: "The hosts an agent is permitted to send traffic to.",
		keywords: ["hosts", "safety", "allow all"],
	},
	{
		anchor: "mcp-caps",
		panel: "mcp",
		label: "Load caps",
		description: "Hard ceilings on the load runs an agent may start.",
		keywords: ["safety", "rps", "concurrency", "iterations"],
	},
	{
		anchor: "mcp-writes",
		panel: "mcp",
		label: "Write access",
		description: "Whether agents may change saved requests, environments and engine config.",
		keywords: ["read-only", "safety", "permission"],
	},
];
