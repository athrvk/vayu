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

interface ElectronAPI {
	// Engine management
	restartEngine: () => Promise<{ success: boolean; error?: string }>;
	getEngineStatus: () => Promise<{ running: boolean; url: string | null }>;

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
	openReleasePage: (url: string) => Promise<void>;

	// Menu-driven navigation
	onOpenSettings: (callback: () => void) => () => void;

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
