/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * First paint does not wait on the engine (issue #1144).
 *
 * The window used to be created only after the sidecar's `/health` handshake
 * resolved, which put the engine's entire startup - `db.init()`'s orphan
 * reconciliation, inbox cleanup and page-reclaim rewrite, all of it before the
 * engine listens at all - in front of a blank screen, for up to the 45-second
 * readiness budget. The renderer never needed it: it polls `/health` over HTTP
 * itself and renders the disconnected state until one answers.
 *
 * `main.ts` creates windows and starts the engine at import time, so the wiring
 * itself can only be read - the same characterization approach
 * `renderer-recovery.test.ts` and `quit-shutdown.test.ts` take to main.ts's own
 * sequencing. The behaviour underneath is driven for real in `sidecar.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

describe("startup ordering", () => {
	it("creates the window before it waits on the engine", () => {
		// One tab of indent is the `whenReady` handler's own call. The other,
		// deeper-indented one is the macOS activate handler rebuilding a closed
		// window, which runs long after startup and says nothing about ordering.
		const windowAt = main.indexOf("\n\tcreateWindow();");
		const engineAt = main.indexOf("\n\tawait engineStartup;");

		expect(windowAt).toBeGreaterThan(-1);
		expect(engineAt).toBeGreaterThan(-1);
		expect(windowAt).toBeLessThan(engineAt);
	});

	it("begins the engine's start before app.whenReady, not after the window", () => {
		// The engine's own startup - the database opened and checked before it
		// listens - is the longest wait between launch and data, and none of it
		// needs Chromium. Begun inside the `whenReady` handler it could only
		// start once Chromium had booted and the window had been built; begun
		// with the instance lock it overlaps both. Mutation check: move the
		// assignment into the handler and the begin sits after `whenReady`.
		const begunAt = main.indexOf("\n\tengineStartup = startEngine();");
		const readyAt = main.indexOf("app.whenReady().then(");
		const lockAt = main.indexOf("app.requestSingleInstanceLock()");

		expect(begunAt).toBeGreaterThan(-1);
		expect(readyAt).toBeGreaterThan(-1);
		expect(begunAt).toBeLessThan(readyAt);
		// Inside the primary-instance branch: a losing second instance must not
		// start an engine on top of the one it is handing over to.
		expect(begunAt).toBeGreaterThan(lockAt);
		expect(main.slice(lockAt, begunAt)).toContain("} else {");
		// And only once: the handler awaits the start, it does not begin another.
		expect(main.match(/\bstartEngine\(\);/g)).toHaveLength(1);
	});

	it("waits for a ready app before it reports a failed start", () => {
		// A start begun before `whenReady` can fail before it; a dialog cannot
		// be shown until then.
		const start = main.indexOf("async function startEngine()");
		const readyAt = main.indexOf("await app.whenReady();", start);
		const dialogAt = main.indexOf("showErrorBox", start);

		expect(start).toBeGreaterThan(-1);
		expect(readyAt).toBeGreaterThan(start);
		expect(readyAt).toBeLessThan(dialogAt);
	});

	it("still starts MCP after the window, which is why the ordering rule existed", () => {
		// MCP reads a config file, and a corrupt one once left the app with a
		// headless engine and no window at all. Overlapping the engine with the
		// window does not license overlapping this too.
		const windowAt = main.indexOf("\n\tcreateWindow();");
		// One tab again: `startMcp` is also called by the MCP enable/disable IPC
		// handler, which says nothing about startup ordering.
		const mcpAt = main.indexOf("\n\tawait startMcp();");

		expect(mcpAt).toBeGreaterThan(-1);
		expect(mcpAt).toBeGreaterThan(windowAt);
	});

	/*
	 * Mutation check: move `setupIpcHandlers();` below `await engineStartup;`, or
	 * the updater's four `ipcMain.handle` calls out of `setupIpcHandlers` into
	 * something that runs after it, and this reddens. The renderer's update
	 * invokes rejected with "No handler registered" for as long as the engine
	 * took to come up, when the channels were registered by `initAutoUpdater`.
	 */
	it("registers the update channels before it waits on the engine", () => {
		const channels = [
			"update:restartToInstall",
			"update:openReleasePage",
			"update:check",
			"update:quitForUpdate",
		];
		const setupAt = main.indexOf("\nfunction setupIpcHandlers()");
		const setupEnd = main.indexOf("\n}\n", setupAt);
		const callAt = main.indexOf("\n\tsetupIpcHandlers();");
		const engineAt = main.indexOf("\n\tawait engineStartup;");

		expect(setupAt).toBeGreaterThan(-1);
		expect(setupEnd).toBeGreaterThan(setupAt);
		expect(callAt).toBeGreaterThan(-1);
		expect(engineAt).toBeGreaterThan(-1);
		expect(callAt).toBeLessThan(engineAt);

		const setupBody = main.slice(setupAt, setupEnd);
		for (const channel of channels) {
			expect(setupBody, channel).toContain(`ipcMain.handle("${channel}"`);
			// Registered exactly once in the file: a second registration throws.
			expect(main.split(`ipcMain.handle("${channel}"`), channel).toHaveLength(2);
		}
	});

	/*
	 * Mutation check: move the `activate` listener back below `await
	 * engineStartup;` and this reddens. On macOS a Dock click while the engine is
	 * still starting, with the window closed, then found no handler to rebuild it.
	 */
	/*
	 * Mutation check: drop `await updaterArmed`, the `.finally(markUpdaterArmed)`
	 * or the `engineStartup?.catch(markUpdaterArmed)` and this reddens, as does
	 * a menu item or `update:check` calling the updater without `checkForUpdates`.
	 */
	it("holds a check until the updater is armed, on every path", () => {
		const fnAt = main.indexOf("async function checkForUpdates(");
		const fnBody = main.slice(fnAt, main.indexOf("\n}\n", fnAt));

		expect(fnAt).toBeGreaterThan(-1);
		expect(fnBody.indexOf("await updaterArmed")).toBeGreaterThan(-1);
		expect(main).toContain(".finally(markUpdaterArmed)");
		expect(main).toContain("engineStartup?.catch(markUpdaterArmed)");
		expect(main.split('click: () => void checkForUpdates("menu")')).toHaveLength(3);
		expect(main).toContain('ipcMain.handle("update:check", () => checkForUpdates("renderer"))');
		expect(fnBody).toContain("checkForUpdatesNow(source)");
	});

	it("listens for activate before it waits on the engine", () => {
		const activateAt = main.indexOf('\n\tapp.on("activate"');
		const engineAt = main.indexOf("\n\tawait engineStartup;");

		expect(activateAt).toBeGreaterThan(-1);
		expect(engineAt).toBeGreaterThan(-1);
		expect(activateAt).toBeLessThan(engineAt);
	});

	it("does not quit the app for an engine that is merely slow", () => {
		// The whole point of the split: `EngineNotReadyError` returns, everything
		// else still reaches the dialog and the quit below it.
		const notReadyAt = main.indexOf("error instanceof EngineNotReadyError");
		const quitAt = main.indexOf("app.quit();", notReadyAt);

		expect(notReadyAt).toBeGreaterThan(-1);
		expect(quitAt).toBeGreaterThan(notReadyAt);
		// The early return sits between the two, so a slow engine never reaches
		// the quit. Revert it and this window contains no `return`.
		expect(main.slice(notReadyAt, quitAt)).toContain("return;");
	});

	/*
	 * #2118. Mutation check: drop the early return from the
	 * `EnginePortInUseError` branch and this reddens - the launch ends on a
	 * dialog the user can do nothing about, which is what the issue was.
	 */
	it("does not quit the app when another program holds every engine port", () => {
		const start = main.indexOf("async function startEngine()");
		const portInUseAt = main.indexOf("error instanceof EnginePortInUseError", start);
		const quitAt = main.indexOf("app.quit();", portInUseAt);

		expect(start).toBeGreaterThan(-1);
		expect(portInUseAt).toBeGreaterThan(start);
		expect(quitAt).toBeGreaterThan(portInUseAt);
		expect(main.slice(portInUseAt, quitAt)).toContain("return;");
		// And the reason is kept for the renderer, not only logged.
		expect(main.slice(portInUseAt, quitAt)).toContain("engineStartFailure = error.message;");
	});

	/*
	 * #2118. The renderer reads the start failure to decide an engine is not
	 * coming; a retry in flight must not keep reporting the one it replaces.
	 * Mutation check: drop the clear and the slice below has no assignment
	 * before the restart.
	 */
	it("forgets the start failure before a restart tries again", () => {
		const start = main.indexOf("async function restartEngine()");
		const clearAt = main.indexOf("engineStartFailure = null;", start);
		const restartAt = main.indexOf("await engineSidecar.restart();", start);

		expect(start).toBeGreaterThan(-1);
		expect(clearAt).toBeGreaterThan(start);
		expect(clearAt).toBeLessThan(restartAt);
	});

	/*
	 * #2118. The renderer is told the engine's port once, on its command line,
	 * so the sidecar's choice must exist before the window does. Mutation check:
	 * drop the `enginePortFixed()` wait and the window is built with the default
	 * port while the engine may be on a fallback.
	 */
	it("fixes the engine's port before it creates the window that is told it", () => {
		const fixedAt = main.indexOf("\n\tawait Promise.race([enginePortFixed(), engineStartup]);");
		const windowAt = main.indexOf("\n\tcreateWindow();");

		expect(fixedAt).toBeGreaterThan(-1);
		expect(fixedAt).toBeLessThan(windowAt);
		expect(main).toContain("additionalArguments: [`--vayu-engine-port=${enginePort()}`]");
		// The sidecar's choice is what fixes it.
		expect(main).toMatch(
			/new EngineSidecar\(\s*ENGINE_PORT_CANDIDATES,\s*defaultSidecarSystem,\s*publishEnginePort,\s*receiveGrantSecret\s*\)/
		);
	});

	/*
	 * Mutation check: move the `open-file` registration inside the `whenReady`
	 * handler - which reads as the tidier place for it - and this reddens. That
	 * move is silent at runtime on every platform but macOS, and on macOS it
	 * loses exactly the case the event exists for: a document double-clicked
	 * with Vayu not running raises `open-file` while the app is still starting,
	 * so a listener attached inside `whenReady` is attached too late and the
	 * file is dropped with nothing on screen to say the double-click did
	 * anything (#1364).
	 */
	it("listens for open-file before whenReady, which is when macOS raises it", () => {
		const openFileAt = main.indexOf('app.on("open-file"');
		const whenReadyAt = main.indexOf("app.whenReady().then(");

		expect(openFileAt).toBeGreaterThan(-1);
		expect(whenReadyAt).toBeGreaterThan(-1);
		expect(openFileAt).toBeLessThan(whenReadyAt);
	});

	it("offers an open-file path only after the import allowlist has passed it", () => {
		// `open-file` receives any path the OS hands over, a `.png` dropped on the
		// Dock icon included. The command-line door filters through
		// `isImportableFile`; this one must too, or the renderer is sent a path
		// `specFile:read` then refuses by name.
		const handlerAt = main.indexOf('app.on("open-file"');
		const handlerEnd = main.indexOf("\n\t});", handlerAt);
		const handler = main.slice(handlerAt, handlerEnd);

		expect(handlerAt).toBeGreaterThan(-1);
		expect(handlerEnd).toBeGreaterThan(handlerAt);
		expect(handler).toContain("event.preventDefault();");
		expect(handler).toContain("if (!isImportableFile(filePath)) return;");
		expect(handler.indexOf("isImportableFile(")).toBeLessThan(
			handler.indexOf("openIntents.offer(")
		);
	});

	it("reads the launch's own argv once there is a window to focus", () => {
		// The other half of the same handoff, and it wants the opposite order:
		// `offerArgv` focuses the window when it finds something, so it runs
		// after `createWindow` rather than beside the `open-file` listener.
		// Delivery still waits for the renderer's `did-finish-load` either way.
		const windowAt = main.indexOf("\n\tcreateWindow();");
		const argvAt = main.indexOf("openIntents.offerArgv(process.argv);");

		expect(argvAt).toBeGreaterThan(-1);
		expect(argvAt).toBeGreaterThan(windowAt);
	});
});
