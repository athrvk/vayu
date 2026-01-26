
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Type definitions for Electron API exposed via preload
 */

interface ThemeInfo {
	shouldUseDarkColors: boolean;
	themeSource: "system" | "light" | "dark";
}

interface ElectronAPI {
	// Engine management
	restartEngine: () => Promise<{ success: boolean; error?: string }>;
	getEngineStatus: () => Promise<{ running: boolean; url: string | null }>;

	// Theme management
	getTheme: () => Promise<ThemeInfo>;
	setTheme: (source: "system" | "light" | "dark") => Promise<ThemeInfo>;
	onThemeChanged: (callback: (theme: ThemeInfo) => void) => () => void;

	// Window controls for custom titlebar
	windowMinimize: () => void;
	windowMaximize: () => void;
	windowClose: () => void;
	windowIsMaximized: () => Promise<boolean>;
	onWindowMaximized: (callback: (isMaximized: boolean) => void) => () => void;

	// Platform info
	platform: NodeJS.Platform;

	// App paths
	getAppPaths: () => Promise<{
		appDir: string;
		dataDir: string;
		logsPath: string;
		dbPath: string;
	}>;
}

declare global {
	interface Window {
		electronAPI?: ElectronAPI;
	}
}

export {};
