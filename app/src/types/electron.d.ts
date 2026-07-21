/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Type definitions for Electron API exposed via preload
 */

import type { ThemeSource } from "./ui";
import type {
	McpSafetyConfig,
	McpStatus,
	McpConnectClient,
	McpConnectResult,
	McpToolInfo,
} from "./domain";

interface ThemeInfo {
	shouldUseDarkColors: boolean;
	themeSource: ThemeSource;
}

type UpdateStrategy = "silent" | "notify" | "disabled";

interface UpdateAvailableInfo {
	version: string;
	strategy: UpdateStrategy;
	releaseUrl: string;
	/** Present only on the macOS notify path. */
	installCommand?: string;
}

/**
 * Outcome of a check the user asked for. Mirrors `UpdateCheckResult` in
 * `electron/updater.ts`; the two are separated only by the process boundary.
 *
 * `unavailable` is not a failure — it is a development or unpackaged build,
 * where there is no release feed to ask.
 */
export type UpdateCheckResult =
	| { status: "unavailable"; detail: string }
	| { status: "up-to-date"; version: string }
	| ({ status: "available" } & UpdateAvailableInfo)
	| { status: "error"; message: string };

interface ElectronAPI {
	// Engine management
	restartEngine: () => Promise<{ success: boolean; error?: string }>;
	getEngineStatus: () => Promise<{ running: boolean; url: string | null }>;

	// MCP server (exposes Vayu to agents like Claude Code)
	getMcpStatus: () => Promise<McpStatus>;
	getMcpSafety: () => Promise<McpSafetyConfig>;
	getMcpTools: () => Promise<McpToolInfo[]>;
	updateMcpSafety: (partial: Partial<McpSafetyConfig>) => Promise<McpSafetyConfig>;
	setMcpEnabled: (enabled: boolean) => Promise<McpStatus>;
	connectMcpClient: (client: McpConnectClient) => Promise<McpConnectResult>;

	// Theme management
	getTheme: () => Promise<ThemeInfo>;
	setTheme: (source: ThemeSource) => Promise<ThemeInfo>;
	onThemeChanged: (callback: (theme: ThemeInfo) => void) => () => void;

	// Window controls for custom titlebar
	windowMinimize: () => void;
	windowMaximize: () => void;
	windowClose: () => void;
	windowIsMaximized: () => Promise<boolean>;
	onWindowMaximized: (callback: (isMaximized: boolean) => void) => () => void;

	// Auto-update
	onUpdateAvailable: (callback: (info: UpdateAvailableInfo) => void) => () => void;
	onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void;
	restartToInstallUpdate: () => Promise<void>;
	checkForUpdates: () => Promise<UpdateCheckResult>;
	openReleasePage: (url: string) => Promise<void>;

	// Menu-driven navigation
	onOpenSettings: (callback: () => void) => () => void;

	// Interface scale (page zoom)
	setZoomFactor: (factor: number) => void;
	getZoomFactor: () => number;

	// Open one of the app's own doc links in the system browser
	openAppLink: (key: "docs" | "scripting" | "issues") => Promise<void>;

	// OAuth 2.0 interactive flow
	oauthOpenExternal: (url: string) => Promise<void>;
	oauthOpenWindow: (params: {
		authorizeUrl: string;
		redirectUri: string;
		partition?: string;
	}) => Promise<{ callbackUrl: string } | { error: string }>;

	// Platform info
	platform: NodeJS.Platform;

	// App paths
	getAppPaths: () => Promise<{
		appDir: string;
		dataDir: string;
		logsPath: string;
		dbPath: string;
	}>;

	// Before quit flush handler
	onBeforeQuit: (callback: () => void | Promise<void>) => () => void;
}

declare global {
	interface Window {
		electronAPI?: ElectronAPI;
	}
}

export {};
