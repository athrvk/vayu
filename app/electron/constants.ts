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

/**
 * The identity Windows files the app's toasts under (issue #1358).
 *
 * Must equal `appId` in `electron-builder.json`, which is what the NSIS target
 * stamps on the Start Menu shortcut: Windows matches a toast's AppUserModelID
 * against that shortcut, and a mismatch shows nothing at all rather than
 * showing it under the wrong name. `app-user-model-id.test.ts` compares the
 * two so they cannot drift.
 */
export const APP_USER_MODEL_ID = "com.vayu.client";

// Engine sidecar (must match src/config/network.ts)
export const ENGINE_HOST = "127.0.0.1";
export const ENGINE_PORT = 9876;
/** Lock file written by the engine inside its data dir. */
export const ENGINE_LOCK_FILE = "vayu.lock";
/**
 * Subdirectories the engine creates inside its data dir, named here because the
 * app shows both paths in Settings - General and the engine is what defines
 * them (`engine/src/daemon.cpp:113-114`). Renaming one there without changing
 * it here shows the user a directory that does not exist.
 */
export const ENGINE_LOGS_DIR = "logs";
export const ENGINE_DB_DIR = "db";

// MCP server (Model Context Protocol) - a TypeScript sidecar hosted in this
// main process that exposes the engine's capabilities to agents (Claude Code,
// Codex, Cursor, …) over Streamable HTTP. Bound to loopback only. See
// docs/engine/mcp.md.
export const MCP_HOST = "127.0.0.1";
export const MCP_PORT = 9877;
/**
 * The path the MCP server answers on. Lives here, not in `mcp/http.ts`, because
 * the endpoint URL was previously assembled from a literal `/mcp` in three
 * places (the path served, this URL, and a renderer default) with nothing
 * holding them together. `mcp/http.ts` imports it, and the renderer is told the
 * live URL over `mcp:status` rather than keeping a copy.
 */
export const MCP_PATH = "/mcp";
/** URL agents connect to, e.g. `claude mcp add --transport http vayu <url>`. */
export const MCP_ENDPOINT_URL = `http://${MCP_HOST}:${MCP_PORT}${MCP_PATH}`;

// Engine lifecycle
/**
 * How long the readiness poll waits for a freshly spawned engine to answer
 * `/health` before it stops watching and leaves the engine to the renderer.
 *
 * Budget of *waiting*, not wall clock: the probes themselves are not charged
 * against it, exactly as the attempt count it replaces was not. The engine's
 * own startup housekeeping is priced against this number - see
 * `reclaim_freed_pages` in `engine/src/db/database.cpp`.
 */
export const ENGINE_HEALTH_POLL_BUDGET_MS = 45000;
/**
 * First gap between health probes, doubling to `ENGINE_HEALTH_POLL_MAX_INTERVAL_MS`.
 *
 * A flat 500ms was the entire startup cost of a healthy engine: the first probe
 * necessarily misses (nothing can be listening microseconds after `spawn()`
 * returns), so every launch paid one full quantum before the second probe could
 * succeed. Ramping spends that budget where the engine actually comes up -
 * within tens of milliseconds - while still backing off to a cheap poll for the
 * cold-cache, large-history case that needs the seconds.
 */
export const ENGINE_HEALTH_POLL_INITIAL_INTERVAL_MS = 50;
/** Ceiling the ramped poll interval doubles up to. */
export const ENGINE_HEALTH_POLL_MAX_INTERVAL_MS = 500;
export const ENGINE_HEALTH_REQUEST_TIMEOUT_MS = 2000;
export const ENGINE_SHUTDOWN_REQUEST_TIMEOUT_MS = 2000;
export const ENGINE_GRACEFUL_EXIT_TIMEOUT_MS = 5000;
/**
 * Poll interval while waiting for an *adopted* engine to exit.
 *
 * A spawned engine reports its own exit through the child's `exit` event; an
 * adopted one is not our child, so the only way to learn it is gone is to keep
 * asking the OS. Kept well under the graceful ceiling so the verified kill that
 * follows a stuck engine still happens inside the same quit.
 */
export const ENGINE_EXIT_POLL_INTERVAL_MS = 100;
/**
 * How many stderr lines to keep from a spawned engine, so the message shown
 * when it dies before answering `/health` can quote its last words.
 *
 * Bounded because the drain runs for the engine's whole life, not just for
 * startup - and the reason an engine died at spawn (a missing shared library, a
 * lock it could not acquire) is always in the final few lines.
 */
export const ENGINE_STDERR_TAIL_LINES = 10;
export const ENGINE_RESTART_MAX_RETRIES = 3;
export const ENGINE_RESTART_BASE_DELAY_MS = 1000;
/** Pause between stop and start during restart so the port is released. */
export const ENGINE_PORT_RELEASE_DELAY_MS = 500;
/**
 * Seed for the engine's `maxScenarioDataBytes`, used by the data-file read
 * channel only while the engine cannot answer `GET /config` (see data-file.ts).
 *
 * Not the rule - the live setting is. Mirrors `DATA_FILE_MAX_BYTES` in
 * src/constants/data-files.ts, duplicated here for the same reason the engine
 * port is: the main process cannot import renderer modules.
 */
export const DATA_FILE_MAX_BYTES_SEED = 16 * 1024 * 1024;
/**
 * Seed for the engine's `maxSpecDocumentBytes`, used by the spec sibling-read
 * channel only while the engine cannot answer `GET /config` (see spec-file.ts).
 *
 * Same posture as the data-file seed above: not the rule, and mirroring
 * `SPEC_DOCUMENT_MAX_BYTES` in src/constants/spec-documents.ts because the main
 * process cannot import renderer modules.
 */
export const SPEC_DOCUMENT_MAX_BYTES_SEED = 10 * 1024 * 1024;

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
 * 48px variant exists for a searchbox or a person-picture; the row does hold a
 * search bar now, but a 24px trigger inside a 32px row clears both by 4px, so
 * the extra 16px would buy padding and nothing else.
 *
 * **macOS matches it.** 28px is the macOS standard for a title bar holding a
 * *title*; this one holds a search bar, and the traffic lights are a fixed 12px
 * object that needs air as well. Safari and Chrome both use a taller bar for the
 * same reason. 32 gives the lights 10px above and below and keeps one number
 * across the three platforms - the map stays per-platform because the mechanism
 * is right even when the values agree.
 *
 * The tab strip is no longer in this row - it sits in a second row over the
 * content area, sized by `--tabstrip-height` in `src/index.css`. That token has
 * no mirror here on purpose: nothing the main process draws is that tall.
 *
 * Linux follows Windows: Vayu draws its own decorations there, so there is no
 * system metric to match, and one fewer value to reason about is worth more
 * than a third opinion.
 */
export const TITLEBAR_HEIGHT_BY_PLATFORM = {
	darwin: 32,
	win32: 32,
	linux: 32,
} as const;

/**
 * macOS traffic-light metrics.
 *
 * **14, not 12.** `trafficLightPosition` places the buttons' frame, not the
 * visible circle - the circle is 12pt, the frame around it is not - so centring
 * on 12 leaves the cluster a pixel off. 14 is what the Electron ecosystem
 * centres on (`headerHeight / 2 - MACOS_TRAFFIC_LIGHTS_HEIGHT / 2`); it is a
 * convention rather than a published Apple figure, so it is named here to be
 * adjusted in one place if it proves wrong on a real machine.
 *
 * The original formula used 16, which was wrong in the other direction.
 */
export const TRAFFIC_LIGHT_FRAME_HEIGHT = 14;
/**
 * Leading inset of the light cluster.
 *
 * 20px, not 12. macOS windows have rounded top corners of roughly 10-12px, and
 * at x=12 the close button sits *inside* that curve - the visible area is being
 * cut away diagonally behind it, so the button reads as misaligned no matter
 * how exactly it is centred vertically. Apple's own inset clears the corner for
 * this reason. Moving the cluster out of the curve is what makes the arithmetic
 * centring look centred.
 */
export const TRAFFIC_LIGHT_X = 20;
/**
 * Width the renderer reserves for the cluster, so the title row's leading
 * content does not land under it. A 20px lead plus three buttons on a 20px pitch
 * ends at 84px; 104 leaves a 20px gutter. At 80 that gutter was 16px and the
 * lights read as crammed against what followed. Mirrored by
 * `--traffic-light-inset` in index.css and held to it by
 * `titlebar-height.test.ts`.
 */
export const TRAFFIC_LIGHT_INSET = 104;

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
/**
 * The published docs site, not the repository.
 *
 * `docs/` ships to MkDocs Material on every push to the default branch, so the
 * site is the rendered, navigable, searchable copy of the same files - a raw
 * `blob/master/...` markdown page drops the sidebar, the search box and every
 * relative cross-link. `use_directory_urls` is on, so a page's URL is its path
 * without the `.md`.
 */
export const SITE_URL = "https://athrvk.github.io/vayu/";
export const DOCS_URL = SITE_URL;
export const SCRIPTING_DOCS_URL = `${SITE_URL}engine/scripting/`;
export const ISSUES_URL = `https://github.com/${REPO}/issues`;

// Auto-updater
/** Re-check for updates every 6 hours while the app stays open. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * How long after launch the session's first update check waits.
 *
 * On the silent platforms (Windows, Linux AppImage) a check that finds a
 * release downloads it there and then, and `initAutoUpdater` runs a few lines
 * after the window is created - so a 127MB NSIS pull, or an AppImage apply that
 * reads the whole old image and writes a new one, used to begin at t=0 of a
 * launch. In an API-testing client that transfer competes for the link with the
 * user's own requests, and for the disk with the engine's startup work; with a
 * release every day or two, a daily user paid it every second or third launch.
 *
 * A minute puts it past window creation, engine startup and the first requests
 * a user makes, and costs nothing they can see: the release is still picked up
 * by this launch, by the 6h cycle, or by the next one. Only the timing moves -
 * which platforms download silently, the retry budget and every manual check
 * path are unchanged.
 */
export const UPDATE_STARTUP_CHECK_DELAY_MS = 60 * 1000;
