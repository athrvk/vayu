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
}

declare global {
	interface Window {
		electronAPI?: ElectronAPI;
	}
}

export {};
