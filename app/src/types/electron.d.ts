/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Type definitions for Electron API exposed via preload
 */

import type { ThemeSource, ColorScheme } from "./ui";
import type {
	FileRoot,
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

/** Mirrors `LoginItemState` in `electron/login-item.ts`. */
export interface LoginItemInfo {
	supported: boolean;
	/** Why it is unsupported, as a sentence. `null` when supported. */
	reason: string | null;
	openAtLogin: boolean;
	/** macOS holds the item until the user approves it in System Settings. */
	needsApproval: boolean;
}

interface AccentSchemeInfo {
	accentScheme: ColorScheme | null;
}

/**
 * The host went to sleep under a running test, and came back. Mirrors
 * `HostSuspendedEvent` / `HostResumedEvent` in `electron/power-save.ts`; the two
 * are separated only by the process boundary. Wall-clock milliseconds, because
 * the gap is the thing being reported and the engine's own clock is exactly
 * what the suspend stopped.
 */
interface HostSuspendedEvent {
	at: number;
}

interface HostResumedEvent {
	at: number;
	durationMs: number;
}

/**
 * What the OS should show for the run in front. Mirrors `RunProgressUpdate` in
 * `electron/run-progress.ts`; the two are separated only by the process
 * boundary. `value` is a 0..1 fraction, or null for a run with no denominator -
 * an open-ended load test, or a collection run, whose plan length only the
 * engine resolves.
 */
export type RunProgressUpdate =
	{ state: "running"; value: number | null } | { state: "failed" } | { state: "idle" };

/**
 * One service the engine is holding for this window - what a close would stop
 * (issue #1363). Mirrors `RunningService` in `electron/service-stop-guard.ts`;
 * the two are separated only by the process boundary.
 *
 * `name` is what the user recognises the service by where the kind has one - a
 * mock server serves a named collection - and null where the port is the only
 * name it has, which is how the Services drawer lists inboxes and issuers too.
 */
export interface RunningServiceSummary {
	kind: "inbox" | "mock-server" | "issuer";
	name: string | null;
	port: number;
}

/**
 * A collection as the OS icon's menu needs it. Mirrors `OsIconCollection` in
 * `electron/os-icon.ts`.
 */
export interface OsIconCollection {
	id: string;
	name: string;
}

/**
 * What the renderer reports about the app's own icon. Mirrors `OsIconSignal` in
 * `electron/os-icon.ts`; the two are separated only by the process boundary.
 *
 * None of these says what to paint. Whether a capture counts, and whether a
 * failure is worth marking, both turn on the window's focus, which is main's to
 * answer - the renderer only knows the thing happened.
 */
export type OsIconSignal =
	| { kind: "captured" }
	| { kind: "inboxOpened" }
	| { kind: "runFailed" }
	| { kind: "runFinished" }
	| { kind: "recents"; collections: OsIconCollection[] };

/**
 * Something the OS asked Vayu to open. Mirrors `OpenIntent` in
 * `electron/open-intent.ts`.
 *
 * `import` carries a path, not the document: the renderer reads it back through
 * `readSpecFile`, which is the gated door onto the file system that already
 * exists, rather than main growing a second one. Main records the path as
 * granted when it hands the intent over, so that read is allowed.
 */
export type OpenIntent =
	| { kind: "import"; path: string }
	| { kind: "collection"; collectionId: string }
	| { kind: "newRequest" };

/**
 * Where a notification's click should land. Mirrors `NotifyTarget` in
 * `electron/notify.ts`, which echoes it back untouched: main carries the
 * target, the renderer is the only side that knows what it means.
 */
export type SystemNotificationTarget =
	| { view: "run"; runId: string }
	| { view: "inbox"; inboxId: string }
	| { view: "settings" }
	| { view: "app" };

export interface SystemNotificationRequest {
	/** Which event this is. Echoed on a click, for the renderer's own routing. */
	kind: string;
	title: string;
	body: string;
	target: SystemNotificationTarget;
}

/** Mirrors `NotifyOutcome` in `electron/notify.ts`. */
export type SystemNotificationOutcome =
	"shown" | "focused" | "no-window" | "unsupported" | "unavailable";

export interface SystemNotificationAvailability {
	available: boolean;
	/** Why not, in the words the settings row prints. Null while available. */
	reason: string | null;
}

export interface SystemNotificationActivation {
	kind: string;
	target: SystemNotificationTarget;
}

type UpdateStrategy = "silent" | "notify" | "disabled";

interface UpdateAvailableInfo {
	version: string;
	strategy: UpdateStrategy;
	releaseUrl: string;
	/** Present only on the macOS notify path. */
	installCommand?: string;
}

/** Mirrors `UpdateDownloadProgress` in `electron/updater.ts`. */
interface UpdateDownloadProgress {
	/** 0-100. */
	percent: number;
	bytesPerSecond: number;
	transferred: number;
	total: number;
}

/** Mirrors `UpdateVerificationFailure` in `electron/updater.ts`. */
export interface UpdateVerificationFailure {
	version: string;
	/** Why the attestation was refused, as `update-attestation.ts` words it. */
	reason: string;
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
	kind: "url-bar" | "monaco" | "own-menu" | null;
	variable: string | null;
}

/**
 * A context-menu item the renderer has to run, forwarded from main. Mirrors the
 * forwarded half of `ContextCommand` in `electron/context-menu.ts` - the link
 * actions never leave the main process, so they are not in this union.
 */
export type ContextMenuCommand =
	{ type: "import-command"; text: string } | { type: "edit-variable"; name: string };

/**
 * An engine refusal carried across the IPC hop: its status, code and message,
 * so a 409 still reads as "already there". Mirrors the `refused` and
 * `unreachable` members of `EngineWrite` in `electron/file-trust-client.ts`.
 */
type EngineWriteFailure =
	| { outcome: "refused"; status: number; code: string; message: string }
	| { outcome: "unreachable"; message: string };

/**
 * What `allowFolder` resolves to: the user cancelled, or the engine's answer to
 * allowing the folder they chose, which is `path`. Mirrors `AllowFolderReply`
 * in `electron/file-ipc.ts`.
 */
export type AllowFolderReply =
	| { outcome: "cancelled" }
	| ({ path: string } & ({ outcome: "done"; value: FileRoot } | EngineWriteFailure));

/** What `removeAllowedFolder` resolves to. Mirrors `RemoveFolderReply` in `electron/file-ipc.ts`. */
export type RemoveFolderReply = { outcome: "done"; value: null } | EngineWriteFailure;

/** What `hashDataFile` resolves to. Mirrors `DataFileHashReply` in `electron/data-file.ts`. */
export type DataFileHashReply = { status: "found"; hash: string } | { status: "missing" };

interface ElectronAPI {
	// Engine management
	/**
	 * The port the main process chose for this session's engine (#2118), or
	 * null when the preload could not read one. Fixed for the window's life.
	 */
	enginePort: number | null;
	restartEngine: () => Promise<{ success: boolean; error?: string }>;
	/**
	 * Why the launch (or the last restart) left the app without an engine, when
	 * that is a reason the user can act on - another program holding the port.
	 * Null otherwise.
	 */
	getEngineStartFailure: () => Promise<string | null>;

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

	/**
	 * Start at login (issue #2098). The OS holds the answer - the user can remove
	 * the item outside the app - so it is read here on demand and never mirrored
	 * into a store. `setLoginItem` rejects a non-boolean and resolves with what the
	 * OS now says, which for macOS can still be off with `needsApproval` set.
	 */
	getLoginItem: () => Promise<LoginItemInfo>;
	setLoginItem: (on: boolean) => Promise<LoginItemInfo>;

	// Accent color scheme (Windows and macOS only). Returns null on platforms that
	// don't support system accent colors (Linux) or if no accent color is available.
	getAccentScheme: () => Promise<AccentSchemeInfo>;
	onAccentSchemeChanged: (callback: (data: AccentSchemeInfo) => void) => () => void;

	// Window controls for custom titlebar
	windowMinimize: () => void;
	/** Windows only: opens the app-icon system menu at the given viewport point. */
	windowSystemMenu: (position?: { x: number; y: number }) => void;
	/**
	 * Windows and Linux: opens the application menu (File, Edit, View, Window,
	 * Help) at the given viewport point. A no-op on macOS, where the menu bar
	 * draws it already.
	 */
	windowAppMenu: (position?: { x: number; y: number }) => void;
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
	/**
	 * Silent strategies only: sent instead of `onUpdateDownloaded` when the
	 * installer's build-provenance attestation does not verify, and the update
	 * will not be installed.
	 */
	onUpdateVerificationFailed: (callback: (info: UpdateVerificationFailure) => void) => () => void;
	/** Silent strategies only (Windows, Linux AppImage) - see updater.ts. */
	onDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => () => void;
	restartToInstallUpdate: () => Promise<void>;
	checkForUpdates: () => Promise<UpdateCheckResult>;
	openReleasePage: () => Promise<void>;
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
	openAppLink: (
		key: "docs" | "scripting" | "mcp" | "pmApiCompatibility" | "issues"
	) => Promise<void>;

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
	/** Open the logs directory in the OS file manager (Settings, General). */
	openLogsFolder: () => Promise<string>;
	/**
	 * Open the installer's THIRD_PARTY_NOTICES.txt in the OS viewer (Settings,
	 * General). Resolves with an empty string on success and the reason on
	 * failure; a development build with no staged copy fails with a sentence
	 * that says so.
	 */
	openThirdPartyNotices: () => Promise<string>;

	/**
	 * Forward one `error-logger.ts` record to the app's own log file (#1558).
	 * One-way and unacknowledged - the caller does not wait on a write it
	 * cannot itself recover from. `cat` is `"renderer"` or `"boundary"`; main
	 * validates the shape, applies redaction and the `logLevel` floor, and
	 * caps the channel at 20 records per second per window.
	 */
	log: (record: {
		level: "debug" | "info" | "warn" | "error";
		cat: string;
		msg: string;
		err?: { name: string; message: string; stack?: string };
		fields?: Record<string, unknown>;
	}) => void;

	/**
	 * Absolute path of a picked or dropped `File`, for a body file. Synchronous
	 * (Electron's `webUtils`) and `""` when the object has no path on this
	 * machine. A path is also recorded as picked, so the engine sends it
	 * (#2356); that happens in the preload and main, and nothing here can name
	 * a path to record. Absent outside Electron, which is what the
	 * browser-hosted test environment sees.
	 */
	getFilePath: (file: File) => string;

	/**
	 * Open the system folder picker and allow the folder the user chooses
	 * (#2356): the main process makes the engine write, because only it holds
	 * the secret the engine requires for one. The renderer names the dialog by
	 * key and nothing else - the title is main's, and the picker opens where the
	 * last one ended (#2378). The key mirrors `FolderDialogKey` in
	 * `electron/file-ipc.ts`. Resolves with the engine's answer rather than
	 * rejecting on a refusal. Renderer callers go through
	 * `apiService.allowChosenFolder`. Absent outside Electron.
	 */
	allowFolder: (key: "allow-folder") => Promise<AllowFolderReply>;

	/** Stop allowing a folder, by its row's id. Same reply family; absent outside Electron. */
	removeAllowedFolder: (id: string) => Promise<RemoveFolderReply>;

	/**
	 * Size and modification time of the regular file at an absolute path, for
	 * the binary body editor's file line - never its contents. Null for a
	 * relative or templated path, a missing file, or a directory/device.
	 * Absent outside Electron.
	 */
	statFile: (path: string) => Promise<{ size: number; mtimeMs: number } | null>;

	/**
	 * Re-read a collection's declared data file by path (issue #599). Rejects
	 * with a message the dialog can show as-is when the extension is not one
	 * Vayu opens, the file has moved, it is not a file the user picked, dropped
	 * or opened (#2357: pick it again), or it is over the engine's
	 * `maxScenarioDataBytes`.
	 *
	 * Bytes rather than text: `services/data-files/decode.ts` owns decoding, and
	 * a file re-read here must not disagree with the same file read through the
	 * picker. Absent outside Electron, so every caller has a no-Electron path.
	 * `hash` is the SHA-256 of `bytes` as 64 lowercase hex (issue #2051), the
	 * same digest the picker computes for a hand-picked file.
	 */
	readDataFile: (path: string) => Promise<{ bytes: Uint8Array; fileName: string; hash: string }>;

	/**
	 * The SHA-256 of a declared data file's bytes as they are now, 64 lowercase
	 * hex (issue #2051), without transferring them: the same digest
	 * `readDataFile` answers. A file that has moved resolves
	 * `{ status: "missing" }` (issue #2057) rather than rejecting, since a
	 * rejection reaches the renderer as a bare message; so does a path the user
	 * never picked, dropped or opened (#2357). Rejects for a refused
	 * extension or an empty path; there is no byte cap. Absent outside Electron.
	 */
	hashDataFile: (path: string) => Promise<DataFileHashReply>;

	/**
	 * Hand the main process every remembered data-file location (issue #1742),
	 * so the MCP server can name the file a collection declared. The whole map
	 * each time, never a diff: the main process keeps no copy of its own.
	 */
	publishDataFileLocations: (
		locations: Record<
			string,
			{ path: string; fileName: string; hash?: string; castNumbers?: boolean }
		>
	) => void;

	/**
	 * Hand the main process which tab and environment the user has open (issue
	 * #2045), so the MCP server can answer "the request I have open". The whole
	 * snapshot each time, never a diff. Names and ids only: `label` is never
	 * derived from a resolved URL, which would carry variable values.
	 */
	publishAppFocus: (focus: {
		activeTab: { type: string; entityId: string | null; label: string } | null;
		activeEnvironment: { id: string; name: string } | null;
	}) => void;

	/**
	 * Read a file an imported OpenAPI document references (issue #649), given the
	 * picked document's path and the `$ref` target as the document wrote it - the
	 * main process resolves the second against the first's directory. Rejects
	 * with a message the import dialog can show as-is when the reference is
	 * absolute, names an extension Vayu does not open, is not there, is over
	 * the engine's `maxSpecDocumentBytes`, or the document path is not a file the
	 * user picked, dropped or opened (#2357: pick the file again).
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

	/**
	 * System wake lock, held while a run streams (issue #1357). Resolves to the
	 * token that releases this hold; `releaseWakeLock` answers `false` for a
	 * token that was never live or has already been handed back, which is what
	 * makes a double release safe. Mirrors `power-save.ts` in the main process,
	 * which ref-counts the holds and drops a renderer's own when it goes away.
	 *
	 * Renderer callers go through `@/services/wake-lock` rather than these
	 * directly: one holder per run, and the token bookkeeping in one place.
	 */
	holdWakeLock: (reason: string) => Promise<string>;
	releaseWakeLock: (token: string) => Promise<boolean>;

	/**
	 * The host suspended and resumed anyway, while a run held the lock. The lock
	 * is a request to the OS, not a guarantee - a closed lid or a critical
	 * battery overrides it - so a run's series can still have a gap, and these
	 * are what let the app say how long it was instead of leaving a hole.
	 */
	onHostSuspended: (callback: (event: HostSuspendedEvent) => void) => () => void;
	onHostResumed: (callback: (event: HostResumedEvent) => void) => () => void;

	/**
	 * A run's progress on the Windows taskbar button and the macOS Dock icon
	 * (issue #1362). Mirrors `RunProgressUpdate` in `electron/run-progress.ts`.
	 *
	 * One-way: nothing the OS answers would change what the run does, and a run
	 * that waited on a repaint would be waiting on a window it does not own.
	 * Renderer callers go through `@/services/run-progress`, which holds the one
	 * rule this side cannot: which of two overlapping runs owns the single
	 * indicator the OS gives an application.
	 */
	setRunProgress: (update: RunProgressUpdate) => void;

	/**
	 * What the Dock and taskbar icon carries, and what its menu offers (issue
	 * #1364). Mirrors `electron/os-icon.ts`.
	 *
	 * One-way, for the progress bar's reason: nothing the OS answers would change
	 * what the renderer does. Renderer callers go through `@/services/os-icon`,
	 * which holds the one rule main cannot - which collections the user has been
	 * in, and when the Inbox is on screen.
	 */
	setOsIconSignal: (signal: OsIconSignal) => void;

	/**
	 * The OS handed Vayu something to open: a document dropped on the icon, an
	 * entry picked off the icon's menu, or a Jump List task (issue #1364).
	 *
	 * Main buffers these until this subscription exists, because the earliest of
	 * them arrives on a cold launch before there is a window at all.
	 */
	onOpenIntent: (callback: (intent: OpenIntent) => void) => () => void;

	/**
	 * What the engine is holding for this window, so the close that would stop it
	 * can name it first (issue #1363). Mirrors `RunningService` in
	 * `electron/service-stop-guard.ts`.
	 *
	 * One-way, and published on every change rather than answered on demand: the
	 * question arrives on the gesture the user is already waiting on, and main
	 * has no way to read the queries this side derives the list from.
	 */
	setRunningServices: (services: RunningServiceSummary[]) => void;

	/**
	 * System notifications for the events that finish while the user is in
	 * another application (issue #1358). Mirrors `electron/notify.ts`; the two
	 * are separated only by the process boundary.
	 *
	 * `showNotification` resolves with what became of the request - `shown`,
	 * `focused` (the window was in front, so the toast already said it),
	 * `no-window`, `unsupported`, or `unavailable` (this build cannot show one,
	 * see below). Renderer callers go through `@/services/notify`, which holds
	 * the opt-in check and the one place that knows which events are relevant.
	 *
	 * `notificationAvailability` is what the settings row asks. Vayu ships
	 * ad-hoc signed on macOS, and Electron 42+ refuses notifications from an
	 * application without a code signature - as a `failed` event rather than a
	 * throw, which is why the answer is only certain after the first attempt.
	 */
	showNotification: (request: SystemNotificationRequest) => Promise<SystemNotificationOutcome>;
	notificationAvailability: () => Promise<SystemNotificationAvailability>;

	/**
	 * Post one because the user pressed the button in Settings, and answer with
	 * what the OS did.
	 *
	 * The only path that ignores the focus check and the opt-in, both
	 * deliberately: the user is looking at the panel when they press it, which
	 * is the state every other notification is suppressed in, and a test is how
	 * someone decides whether to turn the setting on. `unavailable` means the
	 * system refused it - which on macOS is the answer that only arrives after
	 * the attempt, and the reason this resolves late rather than immediately.
	 */
	sendTestNotification: () => Promise<SystemNotificationOutcome>;

	/**
	 * A notification was clicked. The window is already coming back to the
	 * front; this says what it was about, so the renderer can open it.
	 */
	onNotificationActivated: (
		callback: (event: SystemNotificationActivation) => void
	) => () => void;

	// Before quit flush handler. The callback reports how the flush went, so
	// main can ask before discarding a save that did not land (#1489).
	onBeforeQuit: (
		callback: () => Promise<{
			saved: number;
			failed: number;
			pending: number;
			reason?: "disk-full";
		}>
	) => () => void;
}

declare global {
	interface Window {
		electronAPI?: ElectronAPI;
	}
}

export {};
