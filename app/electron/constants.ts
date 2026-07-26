/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Electron main-process constants.
 *
 * The main process is built separately from the renderer (tsconfig.node.json)
 * and cannot import renderer modules, so values shared with the UI - most
 * notably the engine port - are duplicated in src/config/network.ts. Keep
 * them in sync.
 */

// Engine sidecar (must match src/config/network.ts)
export const ENGINE_HOST = "127.0.0.1";
export const ENGINE_PORT = 9876;
/** Lock file written by the engine inside its data dir. */
export const ENGINE_LOCK_FILE = "vayu.lock";

// MCP server (Model Context Protocol) - a TypeScript sidecar hosted in this
// main process that exposes the engine's capabilities to agents (Claude Code,
// Codex, Cursor, …) over Streamable HTTP. Bound to loopback only. See
// docs/engine/mcp.md.
export const MCP_HOST = "127.0.0.1";
export const MCP_PORT = 9877;
/** URL agents connect to, e.g. `claude mcp add --transport http vayu <url>`. */
export const MCP_ENDPOINT_URL = `http://${MCP_HOST}:${MCP_PORT}/mcp`;

// Engine lifecycle
export const ENGINE_HEALTH_MAX_ATTEMPTS = 90;
export const ENGINE_HEALTH_POLL_INTERVAL_MS = 500;
export const ENGINE_HEALTH_REQUEST_TIMEOUT_MS = 2000;
export const ENGINE_SHUTDOWN_REQUEST_TIMEOUT_MS = 2000;
export const ENGINE_GRACEFUL_EXIT_TIMEOUT_MS = 5000;
export const ENGINE_RESTART_MAX_RETRIES = 3;
export const ENGINE_RESTART_BASE_DELAY_MS = 1000;
/** Pause between stop and start during restart so the port is released. */
export const ENGINE_PORT_RELEASE_DELAY_MS = 500;

// Window
export const WINDOW_DEFAULT_WIDTH = 1400;
export const WINDOW_DEFAULT_HEIGHT = 900;
export const WINDOW_MIN_WIDTH = 1024;
export const WINDOW_MIN_HEIGHT = 768;
/**
 * Custom titlebar height, per platform. Must match `--titlebar-height` in
 * `src/index.css`, which `titlebar-height.test.ts` holds it to - the renderer
 * and main tsconfigs do not share a module graph, so nothing else can.
 *
 * **32px is the Windows standard**, and also the floor: `titleBarOverlay.height`
 * is what the OS draws its caption buttons at, and those are 46x32. Anything
 * smaller squeezes controls the platform requires to stay fully visible. The
 * 48px variant exists for a searchbox or a person-picture, neither of which
 * this bar has - tabs do not call for extra height.
 *
 * **macOS runs 28px**, its own standard, which still clears the 12px traffic
 * lights with 8px of margin.
 *
 * Linux follows Windows: Vayu draws its own decorations there, so there is no
 * system metric to match, and one fewer value to reason about is worth more
 * than a third opinion.
 */
export const TITLEBAR_HEIGHT_BY_PLATFORM = {
	darwin: 28,
	win32: 32,
	linux: 32,
} as const;

/** Resolved for the running platform; unknown platforms get the Linux value. */
export const TITLEBAR_HEIGHT: number =
	TITLEBAR_HEIGHT_BY_PLATFORM[process.platform as keyof typeof TITLEBAR_HEIGHT_BY_PLATFORM] ??
	TITLEBAR_HEIGHT_BY_PLATFORM.linux;
/**
 * Colours the main process has to name that the renderer owns as tokens.
 *
 * These paint the Windows caption-button overlay and the window's pre-paint
 * background - both set by Electron before any stylesheet exists, so they
 * cannot read a CSS variable and must be duplicated here.
 *
 * They had drifted: the overlay was `#f2f0eb`, a warm cream from the palette
 * before "paper white", against a `--panel` of `#fafafa`. On Windows that put a
 * visibly warmer strip across the right of the title bar in light mode. The
 * hex existed nowhere else in the repo. `titlebar-height.test.ts` now holds
 * these to `src/index.css` the same way it holds the height.
 */
/** `--panel`: the title bar's own surface, so the overlay disappears into it. */
export const TITLEBAR_BG_LIGHT = "#fafafa";
export const TITLEBAR_BG_DARK = "#111113";
/** `--foreground`: the caption glyphs. */
export const TITLEBAR_FG_LIGHT = "#18181b";
export const TITLEBAR_FG_DARK = "#f4f4f5";
/** `--background`: shown for the frame or two before the first paint. */
export const WINDOW_BG_LIGHT = "#f4f4f5";
export const WINDOW_BG_DARK = "#09090b";

/** Debounce for persisting window bounds to disk. */
export const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;

// Dev server (must match vite.config.ts)
export const DEV_SERVER_URL = "http://localhost:5173";

// Project links
export const REPO = "athrvk/vayu";
export const DOCS_URL = `https://github.com/${REPO}#readme`;
export const SCRIPTING_DOCS_URL = `https://github.com/${REPO}/blob/master/docs/engine/scripting.md`;
export const ISSUES_URL = `https://github.com/${REPO}/issues`;

// Auto-updater
/** Re-check for updates every 6 hours while the app stays open. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
