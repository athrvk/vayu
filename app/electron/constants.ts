/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Electron main-process constants. The main process is built apart from the renderer
 * (tsconfig.node.json) and cannot import renderer modules, so values shared with the UI, notably
 * the engine port, are duplicated in src/config/network.ts: keep them in sync.
 */

/**
 * The identity Windows files the app's toasts under (#1358). Must equal `appId` in
 * `electron-builder.json`, which the NSIS target stamps on the Start Menu shortcut: Windows matches
 * a toast's AppUserModelID against that shortcut, and a mismatch shows nothing at all rather than
 * showing it under the wrong name. `app-user-model-id.test.ts` compares the two so they cannot
 * drift.
 *
 * Reverse-DNS of a domain the project holds. `com.vayu.client` would claim `vayu.com`, which it
 * does not, and name the app "the client", the npm package's name, not the product's.
 */
export const APP_USER_MODEL_ID = "io.github.athrvk.vayu";

/**
 * The name Electron itself thinks the app has. `app.getName()` defaults to `package.json`'s `name`,
 * `"vayu-client"` (the npm package), not `electron-builder.json`'s `productName`, `"Vayu"` (the
 * bundle's display name): electron-builder patches the *bundle* (Info.plist, the Windows
 * executable's metadata) but never the asar's `package.json`, so at runtime `app.getName()` returns
 * the npm name on every platform, dev and packaged alike. macOS shows it: the app menu's label and
 * its "About Vayu" / "Quit Vayu" roles are titled from `app.name`, and without this every one reads
 * "vayu-client". Must equal `productName` in `electron-builder.json`; `app-name.test.ts` compares
 * the two so they cannot drift.
 */
export const APP_NAME = "Vayu";

/**
 * The directory under the OS's app-data root (`app.getPath("appData")`) holding everything the app
 * owns: in a packaged build the engine's database and logs, and in every build the renderer's
 * settings, window state and Chromium's profile. Named for the product, the same on every platform,
 * and set by `main.ts` rather than left to Electron, which derives it from whatever `app.name` is
 * on the first read and so varies with import order.
 *
 * `install.sh`, `installer.nsh` and the CI shell-script check read this name; `app-name.test.ts`
 * and `installer-nsh-paths.test.ts` hold them to it.
 */
export const USER_DATA_DIR_NAME = APP_NAME;

// Engine sidecar (must match src/config/network.ts)
export const ENGINE_HOST = "127.0.0.1";
/** The engine's default port: the first candidate, and the one tools outside the app assume. */
export const ENGINE_PORT = 9876;
/**
 * Every port the sidecar may run the engine on, tried in order, so another program holding 9876
 * does not leave the app without an engine (#2118). A fixed list, not an OS-assigned port, because
 * the renderer's CSP is a build-time `<meta>` (`renderer-csp.ts`) and can only name ports known at
 * build time. The fallbacks skip the default `MCP_PORT` (9877) and its neighbours, and a configured
 * MCP port may not be one of them (`validateMcpPort` in `mcp/store.ts`), so the two never collide.
 */
export const ENGINE_PORT_CANDIDATES: readonly number[] = [
	ENGINE_PORT,
	...Array.from({ length: 10 }, (_, index) => 9880 + index),
];
/** Lock file written by the engine inside its data dir. */
export const ENGINE_LOCK_FILE = "vayu.lock";
/**
 * Subdirectories the engine creates in its data dir (`run_daemon` in `engine/src/daemon.cpp`
 * defines them), named here because Settings - General shows both paths: renaming one there alone
 * shows the user a directory that does not exist.
 */
export const ENGINE_LOGS_DIR = "logs";
export const ENGINE_DB_DIR = "db";
/**
 * The per-start secret that gates every write to file trust (#2356): the
 * environment variable the engine reads it from, the header a write carries it
 * in, and its size in random bytes (sent as hex). The engine's halves are
 * `GRANT_SECRET_ENV`, `GRANT_SECRET_HEADER` and `GRANT_SECRET_MIN_LENGTH` in
 * `engine/include/vayu/http/grant_secret.hpp`; `file-trust-client.test.ts`
 * holds the two sides together.
 */
export const ENGINE_GRANT_SECRET_ENV = "VAYU_GRANT_SECRET";
export const ENGINE_GRANT_SECRET_HEADER = "X-Vayu-Grant-Secret";
export const ENGINE_GRANT_SECRET_BYTES = 32;
/**
 * The app log's rotation and retention, mirroring the engine's `maxLogFileBytes` default and
 * `RETAINED_FILES` (`engine/include/vayu/core/constants.hpp`) so `app_<stamp>.log` behaves as
 * `engine_<stamp>.log` does (see `electron/log.ts`).
 */
export const APP_LOG_MAX_BYTES = 64 * 1024 * 1024;
export const APP_LOG_RETENTION_COUNT = 10;

// MCP server (Model Context Protocol): a TypeScript sidecar hosted in this main process that
// exposes the engine's capabilities to agents (Claude Code, Codex, Cursor, …) over Streamable HTTP,
// bound to loopback only. See docs/engine/mcp/index.md.
export const MCP_HOST = "127.0.0.1";
/**
 * The MCP port when Settings has set none, and only that (#3580). The configured port is
 * `readMcpPort()` in `mcp/store.ts`, passed to each engine spawn as its `--mcp-port`; the port in
 * force is the one the listener holds or last failed to bind, else the one the engine was last
 * spawned with (`inForce` in `mcp/status.ts`, which reports `restartRequired` while the two
 * differ).
 */
export const MCP_PORT = 9877;
/** The range `validateMcpPort` accepts: unprivileged, so binding needs no elevated rights on Linux or macOS. */
export const MCP_PORT_MIN = 1024;
export const MCP_PORT_MAX = 65535;
/**
 * The path the MCP server answers on. Here, not in `mcp/http.ts`, so the path served, this URL and
 * the renderer's view of it cannot drift apart: `mcp/http.ts` imports it, and the renderer is told
 * the live URL over `mcp:status` rather than keeping a copy.
 */
export const MCP_PATH = "/mcp";
/** URL agents connect to, e.g. `claude mcp add --transport http --scope user vayu <url>`. */
export function mcpEndpointUrl(port: number): string {
	return `http://${MCP_HOST}:${port}${MCP_PATH}`;
}

// Engine lifecycle
/**
 * How long the readiness poll waits for a freshly spawned engine to answer `/health` before it
 * stops watching and leaves the engine to the renderer. A budget of *waiting*, not wall clock: the
 * probes themselves are not charged against it. The engine's own startup housekeeping is priced
 * against this number (`reclaim_freed_pages` in `engine/src/db/database.cpp`).
 */
export const ENGINE_HEALTH_POLL_BUDGET_MS = 45000;
/**
 * First gap between health probes, doubling to `ENGINE_HEALTH_POLL_MAX_INTERVAL_MS`. The first
 * probe necessarily misses (nothing can be listening microseconds after `spawn()` returns), so a
 * flat 500ms made every launch of a healthy engine pay one full quantum before the second probe
 * could succeed. Ramping spends the budget where the engine comes up, within tens of milliseconds,
 * and still backs off to a cheap poll for the cold-cache, large-history case that needs the
 * seconds.
 */
export const ENGINE_HEALTH_POLL_INITIAL_INTERVAL_MS = 50;
/** Ceiling the ramped poll interval doubles up to. */
export const ENGINE_HEALTH_POLL_MAX_INTERVAL_MS = 500;
export const ENGINE_HEALTH_REQUEST_TIMEOUT_MS = 2000;
export const ENGINE_SHUTDOWN_REQUEST_TIMEOUT_MS = 2000;
/**
 * Deadline for a main-process `/config` read or write (`engine-fetch.ts`). Longer than the health
 * probe because a write takes the engine's DB mutex and a read can queue behind startup
 * housekeeping, yet short enough that a silent engine releases the file dialog it blocks.
 */
export const ENGINE_CONFIG_REQUEST_TIMEOUT_MS = 5000;
/**
 * How long a stopping engine has before it is killed. The engine budgets its
 * final recovery-backup refresh against the same 5 s (`SHUTDOWN_WINDOW_MS` in
 * `engine/include/vayu/core/constants.hpp`), so this must not fall below it.
 */
export const ENGINE_GRACEFUL_EXIT_TIMEOUT_MS = 5000;
/**
 * Poll interval while waiting for an engine this session did not spawn to exit. A spawned engine
 * reports its exit through the child's `exit` event; one found running at start is not our child,
 * so only asking the OS tells us it is gone. Kept well under the graceful ceiling so the verified
 * kill that follows a stuck engine still happens inside the same quit.
 */
export const ENGINE_EXIT_POLL_INTERVAL_MS = 100;
/**
 * Stderr lines kept from a spawned engine, so the message shown when it dies before answering
 * `/health` can quote its last words. Bounded because the drain runs for the engine's whole life,
 * not just startup, and the reason an engine died at spawn (a missing shared library, a lock it
 * could not acquire) is always in the final few lines.
 */
export const ENGINE_STDERR_TAIL_LINES = 10;
export const ENGINE_RESTART_MAX_RETRIES = 3;
export const ENGINE_RESTART_BASE_DELAY_MS = 1000;
/** Pause between stop and start during restart so the port is released. */
export const ENGINE_PORT_RELEASE_DELAY_MS = 500;
/**
 * Seed for the engine's `maxScenarioDataBytes`, used by the data-file read channel only while the
 * engine cannot answer `GET /config` (see data-file.ts). Not the rule; the live setting is. Mirrors
 * `DATA_FILE_MAX_BYTES` in src/constants/data-files.ts, duplicated because the main process cannot
 * import renderer modules.
 */
export const DATA_FILE_MAX_BYTES_SEED = 16 * 1024 * 1024;
/**
 * Seed for the engine's `maxSpecDocumentBytes`, used by the spec sibling-read channel only while
 * the engine cannot answer `GET /config` (see spec-file.ts). Same posture as the data-file seed
 * above: not the rule, and mirroring `SPEC_DOCUMENT_MAX_BYTES` in src/constants/spec-documents.ts
 * because the main process cannot import renderer modules.
 */
export const SPEC_DOCUMENT_MAX_BYTES_SEED = 10 * 1024 * 1024;

// Window
export const WINDOW_DEFAULT_WIDTH = 1400;
export const WINDOW_DEFAULT_HEIGHT = 900;
export const WINDOW_MIN_WIDTH = 1024;
export const WINDOW_MIN_HEIGHT = 768;
/**
 * Custom titlebar height, per platform. Must match `--titlebar-height` in `src/index.css`, which
 * `titlebar-height.test.ts` holds it to: the renderer and main tsconfigs do not share a module
 * graph, so nothing else can.
 *
 * **32px is the Windows standard**, and also the floor: `titleBarOverlay.height` is what the OS
 * draws its 46x32 caption buttons at, and anything smaller squeezes controls the platform requires
 * to stay fully visible. The 48px variant is for a searchbox or a person-picture; the row's search
 * bar (`CommandSearchBar`, `h-target`: 24px at Default, 28px at Comfortable, #1679) clears this row
 * by 4px at Default and 2px at Comfortable, so the extra 16px would buy padding, not control room.
 *
 * **macOS matches it.** 28px is the macOS standard for a title bar holding a *title*; this one
 * holds a search bar, and the traffic lights are a fixed 12px object that needs air too (Safari and
 * Chrome use a taller bar for the same reason). 32 gives the lights 10px above and below and keeps
 * one number across the three platforms; the map stays per-platform because the mechanism is right
 * even when the values agree.
 *
 * The tab strip sits in a second row over the content area, sized by `--tabstrip-height` in
 * `src/index.css`; that token has no mirror here on purpose, as nothing the main process draws is
 * that tall.
 *
 * Linux follows Windows: Vayu draws its own decorations there, so there is no system metric to
 * match, and one fewer value to reason about is worth more than a third opinion.
 */
export const TITLEBAR_HEIGHT_BY_PLATFORM = {
	darwin: 32,
	win32: 32,
	linux: 32,
} as const;

/**
 * macOS traffic-light metrics.
 *
 * **14, not 12.** `trafficLightPosition` places the buttons' frame, not the 12pt visible circle, so
 * centring on 12 leaves the cluster a pixel off. 14 is what the Electron ecosystem centres on
 * (`headerHeight / 2 - MACOS_TRAFFIC_LIGHTS_HEIGHT / 2`); a convention, not a published Apple
 * figure, so it is named here to be adjusted in one place if it proves wrong on a real machine.
 */
export const TRAFFIC_LIGHT_FRAME_HEIGHT = 14;
/**
 * Leading inset of the light cluster: 20px, not 12. macOS windows have rounded top corners of
 * roughly 10-12px, and at x=12 the close button sits *inside* that curve, its visible area cut away
 * diagonally, so it reads as misaligned however exactly it is centred vertically. Apple's own inset
 * clears the corner for this reason.
 */
export const TRAFFIC_LIGHT_X = 20;
/**
 * Width the renderer reserves for the cluster, so the title row's leading content does not land
 * under it. A 20px lead plus three buttons on a 20px pitch ends at 84px; 104 leaves a 20px gutter,
 * where 80's 16px read as crammed. Mirrored by `--traffic-light-inset` in index.css and held to it
 * by `titlebar-height.test.ts`.
 */
export const TRAFFIC_LIGHT_INSET = 104;

/** Resolved for the running platform; unknown platforms get the Linux value. */
export const TITLEBAR_HEIGHT: number =
	TITLEBAR_HEIGHT_BY_PLATFORM[process.platform as keyof typeof TITLEBAR_HEIGHT_BY_PLATFORM] ??
	TITLEBAR_HEIGHT_BY_PLATFORM.linux;
/**
 * Colours the main process must name that the renderer owns as tokens. They paint the Windows
 * caption-button overlay and the window's pre-paint background, both set by Electron before any
 * stylesheet exists, so they cannot read a CSS variable and are duplicated here.
 *
 * `titlebar-height.test.ts` holds them to `src/index.css` as it holds the height: a drifted copy (a
 * warm `#f2f0eb` overlay against a `--panel` of `#fafafa`) puts a visibly warmer strip across the
 * right of the title bar in light mode on Windows.
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

/**
 * The privileged scheme a packaged build serves its renderer from (#2380), so
 * the document has one real origin and CSP `'self'` names it alone. Not plain
 * `vayu`, which a user may well give an OAuth provider as a redirect scheme.
 * `scripts/perf/startup-harness.cjs` spells it again and must match.
 */
export const APP_SCHEME = "vayu-app";
export const APP_HOST = "app";
/** What a packaged window loads; see app-protocol.ts for how it is answered. */
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

// Project links
export const REPO = "athrvk/vayu";
/**
 * The published docs site, not the repository: `docs/` ships to MkDocs Material on every push to
 * the default branch, and a raw `blob/master/...` markdown page drops the sidebar, the search box
 * and every relative cross-link. `use_directory_urls` is on, so a page's URL is its path without
 * the `.md`.
 */
export const SITE_URL = "https://athrvk.github.io/vayu/";
export const DOCS_URL = SITE_URL;
export const SCRIPTING_DOCS_URL = `${SITE_URL}engine/scripting/`;
export const MCP_DOCS_URL = `${SITE_URL}engine/mcp/`;
/** The "Not (yet) supported" section: which `pm.*` APIs a Postman script cannot use. */
export const PM_API_COMPATIBILITY_DOCS_URL = `${SITE_URL}app/pm-api-compatibility/#not-yet-supported`;
export const ISSUES_URL = `https://github.com/${REPO}/issues`;

// Auto-updater
/** Re-check for updates every 6 hours while the app stays open. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * How long after launch the session's first update check waits.
 *
 * On the silent platforms (Windows, Linux AppImage) a check that finds a release downloads it there
 * and then, and `initAutoUpdater` runs a few lines after the window is created, so without the
 * delay a 127MB NSIS pull, or an AppImage apply that reads the whole old image and writes a new
 * one, begins at t=0 of a launch. In an API-testing client that transfer competes for the link with
 * the user's own requests and for the disk with the engine's startup work; with a release every day
 * or two, a daily user would pay it every second or third launch.
 *
 * A minute puts it past window creation, engine startup and the user's first requests, at no cost
 * they can see: the release is still picked up by this launch, by the 6h cycle, or by the next one.
 * Only the timing moves; which platforms download silently, the retry budget and every manual check
 * path are unchanged.
 */
export const UPDATE_STARTUP_CHECK_DELAY_MS = 60 * 1000;
/**
 * Deadline for the GitHub attestations lookup that gates an install (#2372).
 * The API answers in well under a second; without a deadline a connection
 * that never answers would hold the downloaded update forever.
 */
export const UPDATE_ATTESTATION_REQUEST_TIMEOUT_MS = 30 * 1000;
/**
 * Deadline for each attempt at a request of the Sigstore TUF refresh behind that gate (#2738),
 * covering the body as well as the headers. This and `UPDATE_TUF_REQUEST_RETRIES` are
 * `@sigstore/tuf`'s own defaults for the same requests; an unanswered attempt counts as a failed
 * one, and once the retries are spent the refresh fails, and so refuses the update, rather than
 * holding it.
 */
export const UPDATE_TUF_REQUEST_TIMEOUT_MS = 5 * 1000;
/**
 * Retries after a failed first attempt at one TUF request (three attempts in all), for a thrown
 * network error or a 5xx. A 4xx is the repository's verdict and is not retried: `Updater.loadRoot`
 * reads a 403 or 404 on the next root as "no newer root".
 */
export const UPDATE_TUF_REQUEST_RETRIES = 2;
