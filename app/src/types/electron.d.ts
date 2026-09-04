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
	McpDataChangedEvent,
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
 * `unavailable` is not a failure - it is a development or unpackaged build,
 * where there is no release feed to ask.
 */
export type UpdateCheckResult =
	| { status: "unavailable"; detail: string }
	| { status: "up-to-date"; version: string }
	| ({ status: "available" } & UpdateAvailableInfo)
	| { status: "error"; message: string };

/**
 * What the renderer says sits under the pointer for a right-click. Mirrors
 * `ContextTarget` in `electron/context-menu.ts`; only what the main process
 * cannot read from Chromium's own context-menu params.
 */
export interface ContextMenuTarget {
	kind: "url-bar" | "monaco" | null;
	variable: string | null;
}

/**
 * A context-menu item the renderer has to run, forwarded from main. Mirrors the
 * forwarded half of `ContextCommand` in `electron/context-menu.ts` - the link
 * actions never leave the main process, so they are not in this union.
 */
export type ContextMenuCommand =
	| { type: "import-command"; text: string }
	| { type: "edit-variable"; name: string };

interface ElectronAPI {
	// Engine management
	restartEngine: () => Promise<{ success: boolean; error?: string }>;

	// MCP server (exposes Vayu to agents like Claude Code)
	getMcpStatus: () => Promise<McpStatus>;
	getMcpSafety: () => Promise<McpSafetyConfig>;
	getMcpTools: () => Promise<McpToolInfo[]>;
	updateMcpSafety: (partial: Partial<McpSafetyConfig>) => Promise<McpSafetyConfig>;
	setMcpEnabled: (enabled: boolean) => Promise<McpStatus>;
	connectMcpClient: (client: McpConnectClient) => Promise<McpConnectResult>;
	/** An agent's write landed engine-side; invalidate the named family. */
	onMcpDataChanged: (callback: (event: McpDataChangedEvent) => void) => () => void;

	// Theme management
	getTheme: () => Promise<ThemeInfo>;
	setTheme: (source: ThemeSource) => Promise<ThemeInfo>;
	onThemeChanged: (callback: (theme: ThemeInfo) => void) => () => void;

	// Window controls for custom titlebar
	windowMinimize: () => void;
	/** Windows only: opens the app-icon system menu at the given viewport point. */
	windowSystemMenu: (position?: { x: number; y: number }) => void;
	windowMaximize: () => void;
	windowClose: () => void;
	windowIsMaximized: () => Promise<boolean>;
	onWindowMaximized: (callback: (isMaximized: boolean) => void) => () => void;

	// Context menu (#1359)
	/**
	 * Announce what is under the pointer, from the renderer's own `contextmenu`
	 * listener. Mirrors `ContextTarget` in `electron/context-menu.ts`; the call
	 * is synchronous so the announcement lands before the menu it describes.
	 */
	setContextTarget: (target: ContextMenuTarget) => void;
	/** The menu items the renderer owns: a command import, a token's popover. */
	onContextMenuCommand: (callback: (command: ContextMenuCommand) => void) => () => void;

	// Auto-update
	onUpdateAvailable: (callback: (info: UpdateAvailableInfo) => void) => () => void;
	onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void;
	restartToInstallUpdate: () => Promise<void>;
	checkForUpdates: () => Promise<UpdateCheckResult>;
	openReleasePage: (url: string) => Promise<void>;
	/** macOS notify path: quit so the pasted installer command can replace the app. */
	quitForUpdate: () => Promise<void>;

	// Menu-driven navigation
	onOpenSettings: (callback: () => void) => () => void;

	// Interface scale (page zoom)
	setZoomFactor: (factor: number) => void;
	/**
	 * View-menu zoom. The menu nudges the renderer's persisted interface-scale
	 * setting rather than zooming Chromium directly, so the accelerators, the
	 * Appearance panel and the window can never disagree.
	 */
	onZoomCommand: (callback: (command: "in" | "out" | "reset") => void) => () => void;

	/**
	 * A step through the tab navigation history, asked for by the View menu or
	 * by an OS gesture the renderer cannot hear - the mouse's back/forward
	 * buttons where the OS reports them as application commands, and the macOS
	 * swipe (#1245).
	 */
	onNavigateHistory: (callback: (direction: "back" | "forward") => void) => () => void;

	// Open one of the app's own doc links in the system browser
	openAppLink: (key: "docs" | "scripting" | "issues") => Promise<void>;

	// OAuth 2.0 interactive flow
	openExternalUrl: (url: string) => Promise<void>;
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

	/**
	 * Absolute path of a picked `File`, for a multipart file part. Synchronous
	 * (Electron's `webUtils`, not IPC) and `""` when the object has no path on
	 * this machine. Absent outside Electron, which is what the browser-hosted
	 * test environment sees.
	 */
	getFilePath: (file: File) => string;

	/**
	 * Re-read a collection's declared data file by path (issue #599). Rejects
	 * with a message the dialog can show as-is when the extension is not one
	 * Vayu opens, the file has moved, or it is over the engine's
	 * `maxScenarioDataBytes`.
	 *
	 * Bytes rather than text: `services/data-files/decode.ts` owns decoding, and
	 * a file re-read here must not disagree with the same file read through the
	 * picker. Absent outside Electron, so every caller has a no-Electron path.
	 */
	readDataFile: (path: string) => Promise<{ bytes: Uint8Array; fileName: string }>;

	/**
	 * Read a file an imported OpenAPI document references (issue #649), given the
	 * picked document's path and the `$ref` target as the document wrote it - the
	 * main process resolves the second against the first's directory. Rejects
	 * with a message the import dialog can show as-is when the reference is
	 * absolute, names an extension Vayu does not open, is not there, or is over
	 * the engine's `maxSpecDocumentBytes`.
	 *
	 * Bytes rather than text, matching `readDataFile`. Absent outside Electron,
	 * where a multi-file spec simply reports its refs as unresolved.
	 */
	readSpecFile: (
		specPath: string,
		refPath: string
	) => Promise<{ bytes: Uint8Array; fileName: string }>;

	/**
	 * Re-resolve the operating system's proxy into the engine's
	 * `proxySystemUrl` setting (issue #708).
	 *
	 * Resolves to the proxy URL now in force, `""` when this machine proxies
	 * nothing, or `null` when the resolution could not be made - which is
	 * deliberately distinct from `""`, since "no proxy" and "could not ask" must
	 * not read the same. Writes nothing when the answer has not changed, so a
	 * caller may be as eager as it likes.
	 */
	refreshSystemProxy: () => Promise<string | null>;

	// Before quit flush handler
	onBeforeQuit: (callback: () => void | Promise<void>) => () => void;
}

declare global {
	interface Window {
		electronAPI?: ElectronAPI;
	}
}

export {};
