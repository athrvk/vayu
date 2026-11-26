/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Types of the preload's `window.electronAPI`. A type that "mirrors" one in `electron/` is a copy
 * across the process boundary, which this file cannot import: change both together.
 */

import type { ThemeSource, ColorScheme } from "./ui";
import type {
	FileRoot,
	McpDataChangedEvent,
	McpSafetyConfig,
	McpStatus,
	McpSetPortResult,
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
 * The host slept under a running test and came back. Mirrors `HostSuspendedEvent` /
 * `HostResumedEvent` in `electron/power-save.ts`. Wall-clock ms: the gap is what is reported, and
 * the engine's clock is what the suspend stopped.
 */
interface HostSuspendedEvent {
	at: number;
}

interface HostResumedEvent {
	at: number;
	durationMs: number;
}

/**
 * What the OS shows for the run in front. Mirrors `RunProgressUpdate` in
 * `electron/run-progress.ts`. `value` is a 0..1 fraction, or null with no denominator: an
 * open-ended load test, or a collection run, whose plan length only the engine resolves.
 */
export type RunProgressUpdate =
	{ state: "running"; value: number | null } | { state: "failed" } | { state: "idle" };

/**
 * A service the engine holds for this window, which a close would stop (#1363). Mirrors
 * `RunningService` in `electron/service-stop-guard.ts`. `name` is the user's name for it where the
 * kind has one (a mock server's collection), null where the port is its only name, as the Services
 * drawer lists inboxes and issuers.
 */
export interface RunningServiceSummary {
	kind: "inbox" | "mock-server" | "issuer";
	name: string | null;
	port: number;
}

/**
 * The run this window shows live, which the same close would stop (#3604). Mirrors `LiveRun` in
 * `electron/service-stop-guard.ts`. `label` is the run's target ("GET https://..."), when known.
 */
export interface LiveRunSummary {
	kind: "load" | "collection";
	label: string | null;
}

/**
 * A collection as the OS icon's menu needs it. Mirrors `OsIconCollection` in `electron/os-icon.ts`.
 */
export interface OsIconCollection {
	id: string;
	name: string;
}

/**
 * What the renderer reports about the app's icon. Mirrors `OsIconSignal` in `electron/os-icon.ts`.
 * None says what to paint: whether a capture counts or a failure is worth marking turns on window
 * focus, which only main can answer.
 */
export type OsIconSignal =
	| { kind: "captured" }
	| { kind: "inboxOpened" }
	| { kind: "runFailed" }
	| { kind: "runFinished" }
	| { kind: "recents"; collections: OsIconCollection[] };

/**
 * Something the OS asked Vayu to open. Mirrors `OpenIntent` in `electron/open-intent.ts`. `import`
 * carries a path, not the document: the renderer reads it through `readSpecFile`, the existing
 * gated file door, rather than main growing a second one. Main records the path as granted when it
 * hands the intent over, so that read is allowed.
 */
export type OpenIntent =
	| { kind: "import"; path: string }
	| { kind: "collection"; collectionId: string }
	| { kind: "newRequest" };

/**
 * Where a notification's click lands. Mirrors `NotifyTarget` in `electron/notify.ts`, which echoes
 * it untouched: main carries it, only the renderer knows what it means.
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

/** A `refused` download as the renderer keeps it (`update-verification-store`). */
export interface UpdateVerificationFailure {
	version: string;
	/** Why the attestation was refused, as `update-attestation.ts` words it. */
	reason: string;
}

/** Where the update download stands. Mirrors `UpdateDownloadState` in `electron/updater.ts`. */
export type UpdateDownloadState =
	| { kind: "none" }
	| { kind: "downloading"; version: string; progress: UpdateDownloadProgress | null }
	| { kind: "verifying"; version: string }
	/** The only state that installs, from the restart button or on quit. */
	| { kind: "verified"; version: string }
	| { kind: "refused"; version: string; reason: string }
	| { kind: "failed"; version: string; error: string };

/**
 * Outcome of a check the user asked for. Mirrors `UpdateCheckResult` in `electron/updater.ts`.
 * `unavailable` is not a failure: a development or unpackaged build has no release feed to ask.
 */
export type UpdateCheckResult =
	| { status: "unavailable"; detail: string }
	| { status: "up-to-date"; version: string }
	| ({ status: "available" } & UpdateAvailableInfo)
	| { status: "error"; message: string };

/**
 * What the renderer says is under the pointer for a right-click. Mirrors `ContextTarget` in
 * `electron/context-menu.ts`: only what main cannot read from Chromium's context-menu params.
 */
export interface ContextMenuTarget {
	kind: "url-bar" | "monaco" | "own-menu" | null;
	variable: string | null;
}

/**
 * A context-menu item the renderer runs, forwarded from main. Mirrors the forwarded half of
 * `ContextCommand` in `electron/context-menu.ts`; the link actions never leave main.
 */
export type ContextMenuCommand =
	{ type: "import-command"; text: string } | { type: "edit-variable"; name: string };

/**
 * An engine refusal across the IPC hop, with status, code and message, so a 409 still reads as
 * "already there". Mirrors `refused` and `unreachable` of `EngineWrite` in
 * `electron/file-trust-client.ts`.
 */
type EngineWriteFailure =
	| { outcome: "refused"; status: number; code: string; message: string }
	| { outcome: "unreachable"; message: string };

/**
 * What `allowFolder` resolves to: cancelled, or the engine's answer to allowing the chosen folder,
 * `path`. Mirrors `AllowFolderReply` in `electron/file-ipc.ts`.
 */
export type AllowFolderReply =
	| { outcome: "cancelled" }
	| ({ path: string } & ({ outcome: "done"; value: FileRoot } | EngineWriteFailure));

/** What `removeAllowedFolder` resolves to. Mirrors `RemoveFolderReply` in `electron/file-ipc.ts`. */
export type RemoveFolderReply = { outcome: "done"; value: null } | EngineWriteFailure;

/**
 * What `saveFile` resolves to: written, cancelled, or failed after a path was chosen. `fileName` is
 * the last segment of the chosen path (the dialog allows a rename), never the full path. Mirrors
 * `SaveFileReply` in `electron/save-file-ipc.ts`.
 */
export type SaveFileReply =
	| { outcome: "saved"; fileName: string }
	| { outcome: "cancelled" }
	| { outcome: "failed"; fileName: string; message: string };

/** The Logs tab's reader (#3635), mirroring `log-reader.ts` and `log-reader-ipc.ts`. */
export type LogFileSource = "engine" | "app" | "cli" | "mcp";

export interface LogFileInfo {
	name: string;
	source: LogFileSource;
	size: number;
	mtimeMs: number;
}

/** One line of a log file that is a record (`docs/engine/log-record.schema.json`). */
export interface LogFileRecord {
	ts: string;
	level: "debug" | "info" | "warn" | "error";
	src: string;
	cat: string;
	msg: string;
	pid: number;
	tid?: string;
	/** The line as the file holds it, cut at 256 KiB. Mirrors `RAW_LINE_KEY` in `electron/log-reader.ts`. */
	$raw?: string;
	/** Where the line sits in its file. Mirrors `POSITION_KEY` in `electron/log-reader.ts`. */
	$pos?: LogLinePosition;
	[field: string]: unknown;
}

/** A line that is not JSON, or is JSON without the record's required keys. */
export interface UnparsedLogLine {
	unparsed: true;
	raw: string;
	/** Where the line sits in its file, under the key a record carries it under. */
	$pos?: LogLinePosition;
}

/**
 * Where a delivered line sits. Mirrors `LogLinePosition` in `electron/log-reader.ts`: the file's
 * `name` and `id` as a `LogCursor` entry names it, the offset of the line's first byte, and the
 * offset just past its newline (the file's end for a last line without one).
 */
export interface LogLinePosition {
	name: string;
	id: string;
	start: number;
	end: number;
}

export type LogEntry = LogFileRecord | UnparsedLogLine;

/** `field:value`; `exact` (the value was quoted) compares whole and case-sensitive. */
export interface LogFieldTerm {
	field: string;
	value: string;
	exact: boolean;
}

/** What a read or a tail keeps. An absent or empty set does not constrain. */
export interface LogFilter {
	minLevel?: LogFileRecord["level"];
	sources?: string[];
	categories?: string[];
	text?: string;
	terms?: LogFieldTerm[];
}

/**
 * Where a read stopped, per file. The renderer hands back what `logs.read` returned, or one placed
 * by delivered lines' `$pos` (the logs store's `cursorAfterTrim`), never one built from a name.
 */
export interface LogCursor {
	files: { name: string; id: string; offset: number }[];
}

/** At most one of `before`, `around` and `after`; none reads the newest records. */
export interface LogReadRequest {
	/** Continue older from a previous backward or `around` read's `cursor`. */
	before?: LogCursor;
	/** Jump to time: the newest records at or before this `ts`. */
	around?: string;
	/** Continue newer from an `after` read's `cursor` or an `around` read's `newer`. */
	after?: LogCursor;
	filter: LogFilter;
	/** Clamped to 1000 by main. */
	limit: number;
}

/** `cursor`, `more` and `scannedTo` point the way the read went: older, or newer for `after`. */
export interface LogReadResult {
	/** Oldest first. */
	records: LogEntry[];
	/** Where the next page in the same direction starts. */
	cursor: LogCursor;
	/** Data remains in that direction that this call did not search or did not return. */
	more: boolean;
	/** The `ts` of the furthest record this call examined, matching or not. */
	scannedTo: string | null;
	/** An `around` read's: where the records later than the time start, for an `after` read. */
	newer?: LogCursor;
}

/** What `logs.onRecords` delivers: one tail poll's matching records, oldest first. */
export interface LogBatch {
	records: LogEntry[];
	/** Matching records left out because the poll found more than 500. */
	dropped: number;
}

/** What `hashDataFile` resolves to. Mirrors `DataFileHashReply` in `electron/data-file.ts`. */
export type DataFileHashReply = { status: "found"; hash: string } | { status: "missing" };

/**
 * The engine's lifecycle as main's sidecar knows it (#3336). Mirrors `EngineLifecyclePayload` in
 * `electron/engine-lifecycle.ts`. Facts, not a verdict: `slow` is past its readiness budget and
 * still watched; `crashed` left unasked, with exit `code` or `signal`, its last stderr lines, and
 * `error` for a child that failed rather than exited.
 */
export type EngineLifecyclePayload =
	| {
			kind:
				| "idle"
				| "choosingPort"
				| "replacing"
				| "spawning"
				| "ready"
				| "slow"
				| "stopping"
				| "stopped";
	  }
	| {
			kind: "crashed";
			code: number | null;
			signal: string | null;
			stderrTail: string[];
			error: string | null;
	  };

interface ElectronAPI {
	// Engine management
	/**
	 * The port main chose for this session's engine (#2118); null if the preload read none. Fixed.
	 */
	enginePort: number | null;
	restartEngine: () => Promise<{ success: boolean; error?: string }>;
	/**
	 * Whether Restart engine may go on. Asks first when the live run would stop with it, else true
	 * at once (#3604). Never rejects: a question that could not be asked is false.
	 */
	confirmEngineRestart: () => Promise<boolean>;
	/**
	 * Why launch (or the last restart) left no engine, when the user can act on it (another program
	 * holds the port). Null otherwise.
	 */
	getEngineStartFailure: () => Promise<string | null>;
	/** The engine's lifecycle now, for a window that loaded after the last push. */
	getEngineLifecycle: () => Promise<EngineLifecyclePayload>;
	/** Every lifecycle change from here on. Returns the unsubscribe. */
	onEngineLifecycle: (callback: (lifecycle: EngineLifecyclePayload) => void) => () => void;

	// MCP server (exposes Vayu to agents like Claude Code)
	getMcpStatus: () => Promise<McpStatus>;
	getMcpSafety: () => Promise<McpSafetyConfig>;
	getMcpTools: () => Promise<McpToolInfo[]>;
	updateMcpSafety: (partial: Partial<McpSafetyConfig>) => Promise<McpSafetyConfig>;
	setMcpEnabled: (enabled: boolean) => Promise<McpStatus>;
	/** Validate and persist the MCP port; it takes effect when the engine restarts (#3580). */
	setMcpPort: (port: number) => Promise<McpSetPortResult>;
	connectMcpClient: (client: McpConnectClient) => Promise<McpConnectResult>;
	/** An agent's write landed engine-side; invalidate the named family. */
	onMcpDataChanged: (callback: (event: McpDataChangedEvent) => void) => () => void;

	// Theme management
	getTheme: () => Promise<ThemeInfo>;
	setTheme: (source: ThemeSource) => Promise<ThemeInfo>;
	onThemeChanged: (callback: (theme: ThemeInfo) => void) => () => void;

	/**
	 * Start at login (#2098). The OS holds the answer (the user can remove the item outside the
	 * app), so it is read on demand, never mirrored into a store. `setLoginItem` rejects a
	 * non-boolean and resolves with what the OS now says, which on macOS can still be off with
	 * `needsApproval` set.
	 */
	getLoginItem: () => Promise<LoginItemInfo>;
	setLoginItem: (on: boolean) => Promise<LoginItemInfo>;

	// Accent scheme (Windows and macOS only): null on Linux, which has no system accent, or when
	// none is set.
	getAccentScheme: () => Promise<AccentSchemeInfo>;
	onAccentSchemeChanged: (callback: (data: AccentSchemeInfo) => void) => () => void;

	// Window controls for custom titlebar
	windowMinimize: () => void;
	/** Windows only: opens the app-icon system menu at the given viewport point. */
	windowSystemMenu: (position?: { x: number; y: number }) => void;
	/**
	 * Windows and Linux: opens the application menu at the given viewport point. A no-op on macOS,
	 * whose menu bar draws it.
	 */
	windowAppMenu: (position?: { x: number; y: number }) => void;
	windowMaximize: () => void;
	windowClose: () => void;
	windowIsMaximized: () => Promise<boolean>;
	onWindowMaximized: (callback: (isMaximized: boolean) => void) => () => void;

	// Context menu (#1359)
	/**
	 * Announces what is under the pointer, from the renderer's `contextmenu` listener. Synchronous,
	 * so it lands before the menu it describes.
	 */
	setContextTarget: (target: ContextMenuTarget) => void;
	/** The menu items the renderer owns: a command import, a token's popover. */
	onContextMenuCommand: (callback: (command: ContextMenuCommand) => void) => () => void;

	// Auto-update
	onUpdateAvailable: (callback: (info: UpdateAvailableInfo) => void) => () => void;
	/** Silent strategies only: every change to the download, on `update:state`. */
	onUpdateState: (callback: (state: UpdateDownloadState) => void) => () => void;
	/**
	 * The download now, for a renderer that mounts after a push it missed (a reload keeps
	 * `verified`). `none` until the updater loads.
	 */
	getUpdateState: () => Promise<UpdateDownloadState>;
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
	 * View-menu zoom. The menu nudges the persisted interface-scale setting rather than zooming
	 * Chromium, so the accelerators, the Appearance panel and the window never disagree.
	 */
	onZoomCommand: (callback: (command: "in" | "out" | "reset") => void) => () => void;

	/**
	 * A tab-history step from the View menu or an OS gesture the renderer cannot hear: mouse
	 * back/forward buttons the OS reports as application commands, and the macOS swipe (#1245).
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
		timeoutMs: number;
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
	/** The log files, read through main (#3635); a malformed or non-app-window call rejects. */
	logs: {
		list: () => Promise<LogFileInfo[]>;
		read: (request: LogReadRequest) => Promise<LogReadResult>;
		/** Starts this window's tail, replacing one already running. */
		tailStart: (filter: LogFilter) => Promise<void>;
		tailStop: () => Promise<void>;
		/** Subscribe to the tail's batches; returns the unsubscribe. */
		onRecords: (callback: (batch: LogBatch) => void) => () => void;
	};
	/**
	 * Opens the installer's THIRD_PARTY_NOTICES.txt in the OS viewer (Settings, General). Resolves
	 * `""` on success, else the reason; a development build without a staged copy says so.
	 */
	openThirdPartyNotices: () => Promise<string>;

	/**
	 * Forwards one `error-logger.ts` record to the app's log file (#1558). One-way and
	 * unacknowledged: the caller cannot recover from a failed write. `cat` is `"renderer"` or
	 * `"boundary"`; main validates the shape, redacts, applies the `logLevel` floor and caps the
	 * channel at 20 records per second per window.
	 */
	log: (record: {
		level: "debug" | "info" | "warn" | "error";
		cat: string;
		msg: string;
		err?: { name: string; message: string; stack?: string };
		fields?: Record<string, unknown>;
	}) => void;

	/**
	 * Absolute path of a picked or dropped `File`, for a body file. Synchronous (Electron's
	 * `webUtils`); `""` when it has no path on this machine. The path is also recorded as picked,
	 * so the engine sends it (#2356); the preload and main do that, and nothing here can name a
	 * path to record. Absent outside Electron, as in the browser-hosted tests.
	 */
	getFilePath: (file: File) => string;

	/**
	 * Opens the system folder picker and allows the chosen folder (#2356). Main makes the engine
	 * write, because only it holds the secret the engine requires. The renderer names the dialog by
	 * key (mirroring `FolderDialogKey` in `electron/file-ipc.ts`); the title is main's, and the
	 * picker opens where the last ended (#2378). Resolves with the engine's answer, never rejecting
	 * on a refusal. Renderer callers use `apiService.allowChosenFolder`. Absent outside Electron.
	 */
	allowFolder: (key: "allow-folder") => Promise<AllowFolderReply>;

	/** Stop allowing a folder, by its row's id. Same reply family; absent outside Electron. */
	removeAllowedFolder: (id: string) => Promise<RemoveFolderReply>;

	/**
	 * Size and mtime of the regular file at an absolute path, for the binary body's file line,
	 * never its contents. Null for a relative or templated path, a missing file, or a
	 * directory/device. Absent outside Electron.
	 */
	statFile: (path: string) => Promise<{ size: number; mtimeMs: number } | null>;

	/**
	 * Opens the save dialog on `suggestedName` (main keeps its last segment, in Downloads) and
	 * writes `contents`, text as UTF-8 (#3246). Rejects before any dialog when main refuses the
	 * call. Renderer callers use `lib/download-text-file.ts`. Absent outside Electron.
	 */
	saveFile: (contents: string | Uint8Array, suggestedName: string) => Promise<SaveFileReply>;

	/**
	 * Re-reads a collection's declared data file by path (#599). Rejects with a message the dialog
	 * shows as is when the extension is not one Vayu opens, the file moved, it was not picked,
	 * dropped or opened (#2357: pick it again), or it is over the engine's `maxScenarioDataBytes`.
	 * Bytes, not text: `services/data-files/decode.ts` owns decoding, so a re-read cannot disagree
	 * with the picker. `hash` is `bytes`' SHA-256 as 64 lowercase hex (#2051), the picker's digest.
	 * Absent outside Electron, so every caller has a no-Electron path.
	 */
	readDataFile: (path: string) => Promise<{ bytes: Uint8Array; fileName: string; hash: string }>;

	/**
	 * A declared data file's SHA-256 as it is now, 64 lowercase hex (#2051), without transferring
	 * the bytes: `readDataFile`'s digest. A moved file resolves `{ status: "missing" }` (#2057)
	 * rather than rejecting, since a rejection reaches the renderer as a bare message; so does a
	 * path never picked, dropped or opened (#2357). Rejects a refused extension or an empty path;
	 * no byte cap. Absent outside Electron.
	 */
	hashDataFile: (path: string) => Promise<DataFileHashReply>;

	/**
	 * Hands main every remembered data-file location (#1742), so the MCP server can name a
	 * collection's declared file. The whole map each time, never a diff: main keeps no copy.
	 */
	publishDataFileLocations: (
		locations: Record<
			string,
			{ path: string; fileName: string; hash?: string; castNumbers?: boolean }
		>
	) => void;

	/**
	 * Hands main the open tab and environment (#2045), so the MCP server can answer "the request I
	 * have open". The whole snapshot, never a diff. Names and ids only: `label` never comes from a
	 * resolved URL, which would carry variable values.
	 */
	publishAppFocus: (focus: {
		activeTab: { type: string; entityId: string | null; label: string } | null;
		activeEnvironment: { id: string; name: string } | null;
	}) => void;

	/**
	 * Reads a file an imported OpenAPI document references (#649), given the picked document's path
	 * and the `$ref` target as written; main resolves the second against the first's directory.
	 * Rejects with a message the import dialog shows as is when the reference is absolute, names an
	 * extension Vayu does not open, is missing, is over the engine's `maxSpecDocumentBytes`, or the
	 * document was not picked, dropped or opened (#2357: pick it again). Bytes, as `readDataFile`.
	 * Absent outside Electron, where a multi-file spec reports its refs unresolved.
	 */
	readSpecFile: (
		specPath: string,
		refPath: string
	) => Promise<{ bytes: Uint8Array; fileName: string }>;

	/**
	 * Re-resolves the OS proxy into the engine's `proxySystemUrl` setting (#708). Resolves to the
	 * URL in force, `""` when this machine proxies nothing, or `null` when it could not resolve:
	 * "no proxy" and "could not ask" must not read the same. Writes nothing when the answer is
	 * unchanged, so callers may be eager.
	 */
	refreshSystemProxy: () => Promise<string | null>;

	/**
	 * System wake lock while a run streams (#1357). Resolves to the token that releases this hold;
	 * `releaseWakeLock` answers `false` for a token never live or already returned, which makes a
	 * double release safe. Main's `power-save.ts` ref-counts the holds and drops a renderer's own
	 * when it goes away. Renderer callers use `@/services/wake-lock`: one holder per run, the token
	 * bookkeeping in one place.
	 */
	holdWakeLock: (reason: string) => Promise<string>;
	releaseWakeLock: (token: string) => Promise<boolean>;

	/**
	 * The host suspended anyway while a run held the lock: the lock is a request, not a guarantee
	 * (a closed lid or critical battery overrides it), so a series can have a gap, and these let
	 * the app say how long it was.
	 */
	onHostSuspended: (callback: (event: HostSuspendedEvent) => void) => () => void;
	onHostResumed: (callback: (event: HostResumedEvent) => void) => () => void;

	/**
	 * A run's progress on the Windows taskbar button and the macOS Dock icon (#1362). One-way:
	 * nothing the OS answers changes the run, and a run waiting on a repaint would wait on a window
	 * it does not own. Renderer callers use `@/services/run-progress`, which decides which of two
	 * overlapping runs owns the OS's single indicator.
	 */
	setRunProgress: (update: RunProgressUpdate) => void;

	/**
	 * What the Dock and taskbar icon carries and its menu offers (#1364), mirroring
	 * `electron/os-icon.ts`. One-way, as `setRunProgress`. Renderer callers use
	 * `@/services/os-icon`, which holds what main cannot know: the collections the user has been
	 * in, and when the Inbox is on screen.
	 */
	setOsIconSignal: (signal: OsIconSignal) => void;

	/**
	 * The OS handed Vayu something to open: a document dropped on the icon, an icon-menu entry, or
	 * a Jump List task (#1364). Main buffers these until this subscription exists, because the
	 * first can arrive on a cold launch before any window.
	 */
	onOpenIntent: (callback: (intent: OpenIntent) => void) => () => void;

	/**
	 * What the engine holds for this window, so a close that would stop it names it first (#1363),
	 * mirroring `RunningService` in `electron/service-stop-guard.ts`. Published on every change,
	 * not answered on demand: the question comes on a gesture the user is waiting on, and main
	 * cannot read the queries this list derives from.
	 */
	setRunningServices: (services: RunningServiceSummary[]) => void;

	/** The live run, or `null` when none, so the same close names it (#3604). Pushed on change. */
	setLiveRun: (run: LiveRunSummary | null) => void;

	/**
	 * System notifications for events that finish while the user is in another app (#1358),
	 * mirroring `electron/notify.ts`. `showNotification` resolves with what became of it: `shown`,
	 * `focused` (the window was in front, so the toast said it), `no-window`, `unsupported`, or
	 * `unavailable` (this build cannot show one). Renderer callers use `@/services/notify`, which
	 * holds the opt-in check and knows which events are relevant. `notificationAvailability` is
	 * what the settings row asks: Vayu ships ad-hoc signed on macOS, and Electron 42+ refuses
	 * notifications from an app without a code signature as a `failed` event, not a throw, so the
	 * answer is only certain after a first attempt.
	 */
	showNotification: (request: SystemNotificationRequest) => Promise<SystemNotificationOutcome>;
	notificationAvailability: () => Promise<SystemNotificationAvailability>;

	/**
	 * Posts one because the user pressed the Settings button, and answers with what the OS did. The
	 * only path that skips the focus check and the opt-in, deliberately: the user is looking at the
	 * panel (the state every other notification is suppressed in), and a test is how they decide to
	 * turn it on. `unavailable` means the system refused it, which on macOS only arrives after the
	 * attempt, so this resolves late.
	 */
	sendTestNotification: () => Promise<SystemNotificationOutcome>;

	/**
	 * A notification was clicked. The window is already coming forward; this says what it was
	 * about.
	 */
	onNotificationActivated: (
		callback: (event: SystemNotificationActivation) => void
	) => () => void;

	// Before-quit flush. The callback reports how the flush went, so main can ask before discarding
	// a save that did not land (#1489).
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
