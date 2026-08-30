/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A dead PID must not cost a subprocess.
 *
 * The engine writes `vayu.lock` and releases it only on a clean shutdown - it
 * never unlinks the file - so the *ordinary* state at launch is a lock file
 * naming a process that is long gone. Windows answered that question by
 * spawning cmd.exe and tasklist, 52.5ms median measured on a CI runner, on the
 * Electron main-process event loop, every single boot; Unix had had the cheap
 * `process.kill(pid, 0)` early-out since the beginning (#1148).
 *
 * `sidecar.test.ts` drives the lifecycle through a fake `SidecarSystem` and
 * deliberately mocks nothing else, so the probe underneath that seam is exactly
 * the part it cannot see. These cases go the other way: the real
 * `defaultSidecarSystem` against a stubbed `process.kill` and a stubbed
 * `execSync`, so "no subprocess was spawned" is an assertion rather than a
 * hope. Both platform branches are driven by stubbing `process.platform` - a
 * test that reads the host's would only ever exercise the runner it landed on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "child_process";

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return { ...actual, execSync: vi.fn() };
});

vi.mock("electron", () => ({
	app: {
		getPath: () => "",
		getAppPath: () => "",
		getVersion: () => "0.0.0-test",
	},
}));

import { defaultSidecarSystem } from "./sidecar";

const LIVE_PID = 4242;
const DEAD_PID = 4243;

/** The tasklist row a real engine produces, and one from something else. */
const ENGINE_ROW = '"vayu-engine.exe","4242","Console","1","12,345 K"\n';
const STRANGER_ROW = '"notepad.exe","4242","Console","1","12,345 K"\n';
/** What tasklist prints when its PID filter matches nothing. */
const NO_SUCH_TASK = "INFO: No tasks are running which match the specified criteria.\n";

const realPlatform = process.platform;

function stubPlatform(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/**
 * A fake OS process table: which PIDs are alive, and which of those we may
 * signal. `process.kill` is the probe under test on the aliveness half, so it
 * is stubbed rather than pointed at a real process - a real live PID we are
 * allowed to signal is exactly what a test cannot conjure portably.
 */
function stubProcessTable(table: { alive?: number[]; aliveButForeign?: number[] } = {}) {
	const alive = new Set(table.alive ?? []);
	const foreign = new Set(table.aliveButForeign ?? []);

	return vi.spyOn(process, "kill").mockImplementation((pid: number) => {
		if (alive.has(pid)) return true;
		const err: NodeJS.ErrnoException = new Error(foreign.has(pid) ? "EPERM" : "ESRCH");
		err.code = foreign.has(pid) ? "EPERM" : "ESRCH";
		throw err;
	});
}

/** What the name-verification subprocess would print, if it is reached at all. */
function stubProcessName(output: string) {
	vi.mocked(execSync).mockReturnValue(output);
}

beforeEach(() => {
	vi.mocked(execSync).mockReset();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	stubPlatform(realPlatform);
});

describe("engine aliveness probe - the cheap half", () => {
	it("spawns nothing for a dead PID on Windows", () => {
		stubPlatform("win32");
		const kill = stubProcessTable({ alive: [LIVE_PID] });

		expect(defaultSidecarSystem.isEngineProcessAlive(DEAD_PID)).toBe(false);

		// The whole point: the dominant boot case - a stale lock file - is
		// answered by a signal-0 probe, and tasklist is never reached.
		expect(kill).toHaveBeenCalledWith(DEAD_PID, 0);
		expect(execSync).not.toHaveBeenCalled();
	});

	it("spawns nothing for a dead PID off Windows", () => {
		stubPlatform("linux");
		const kill = stubProcessTable({ alive: [LIVE_PID] });

		expect(defaultSidecarSystem.isEngineProcessAlive(DEAD_PID)).toBe(false);

		expect(kill).toHaveBeenCalledWith(DEAD_PID, 0);
		expect(execSync).not.toHaveBeenCalled();
	});

	it("refuses a PID that is not one, before signalling anything", () => {
		stubPlatform("linux");
		const kill = stubProcessTable({ alive: [LIVE_PID] });

		// A garbled or truncated lock file is the source here, and on Unix a
		// zero or negative target is a *process group* - this app's own.
		for (const notAPid of [0, -1, -LIVE_PID, Number.NaN, 1.5]) {
			expect(defaultSidecarSystem.isEngineProcessAlive(notAPid)).toBe(false);
			expect(defaultSidecarSystem.killEngineProcess(notAPid)).toBe(false);
		}

		expect(kill).not.toHaveBeenCalled();
		expect(execSync).not.toHaveBeenCalled();
	});
});

describe("engine aliveness probe - the name half", () => {
	it("still name-verifies a live PID on Windows, so a recycled one is not ours", () => {
		stubPlatform("win32");
		stubProcessTable({ alive: [LIVE_PID] });
		stubProcessName(STRANGER_ROW);

		// PID reuse is the reason the subprocess exists: alive is not enough.
		expect(defaultSidecarSystem.isEngineProcessAlive(LIVE_PID)).toBe(false);
		expect(execSync).toHaveBeenCalledOnce();
		expect(vi.mocked(execSync).mock.calls[0][0]).toContain(`PID eq ${LIVE_PID}`);
	});

	it("recognises the engine on Windows", () => {
		stubPlatform("win32");
		stubProcessTable({ alive: [LIVE_PID] });
		stubProcessName(ENGINE_ROW);

		expect(defaultSidecarSystem.isEngineProcessAlive(LIVE_PID)).toBe(true);
	});

	it("hides the console window the name check would otherwise flash", () => {
		stubPlatform("win32");
		stubProcessTable({ alive: [LIVE_PID] });
		stubProcessName(ENGINE_ROW);

		defaultSidecarSystem.isEngineProcessAlive(LIVE_PID);

		expect(vi.mocked(execSync).mock.calls[0][1]).toMatchObject({ windowsHide: true });
	});

	it("reads a PID filter that matched nothing as not-the-engine", () => {
		stubPlatform("win32");
		stubProcessTable({ alive: [LIVE_PID] });
		stubProcessName(NO_SUCH_TASK);

		expect(defaultSidecarSystem.isEngineProcessAlive(LIVE_PID)).toBe(false);
	});

	it("name-verifies a live PID off Windows", () => {
		stubPlatform("darwin");
		stubProcessTable({ alive: [LIVE_PID] });
		stubProcessName("vayu-engine\n");

		expect(defaultSidecarSystem.isEngineProcessAlive(LIVE_PID)).toBe(true);
		expect(vi.mocked(execSync).mock.calls[0][0]).toContain(`ps -p ${LIVE_PID}`);
	});

	it("verifies a process it is not allowed to signal rather than assuming either way", () => {
		stubPlatform("linux");
		stubProcessTable({ aliveButForeign: [LIVE_PID] });
		stubProcessName("vayu-engine\n");

		// EPERM says something holds the PID; only the name says whose it is.
		expect(defaultSidecarSystem.isEngineProcessAlive(LIVE_PID)).toBe(true);
		expect(execSync).toHaveBeenCalledOnce();
	});

	it("treats a name it could not read as not-the-engine", () => {
		stubPlatform("linux");
		stubProcessTable({ alive: [LIVE_PID] });
		vi.mocked(execSync).mockImplementation(() => {
			throw new Error("ps: command not found");
		});

		expect(defaultSidecarSystem.isEngineProcessAlive(LIVE_PID)).toBe(false);
	});
});

describe("engine kill path", () => {
	it("does not reach for taskkill on a PID nothing holds", () => {
		stubPlatform("win32");
		stubProcessTable({ alive: [LIVE_PID] });

		expect(defaultSidecarSystem.killEngineProcess(DEAD_PID)).toBe(false);
		expect(execSync).not.toHaveBeenCalled();
	});

	it("kills a name-verified engine and nothing else", () => {
		stubPlatform("linux");
		const kill = stubProcessTable({ alive: [LIVE_PID] });
		stubProcessName("vayu-engine\n");

		expect(defaultSidecarSystem.killEngineProcess(LIVE_PID)).toBe(true);
		expect(kill).toHaveBeenCalledWith(LIVE_PID, "SIGKILL");
	});

	it("leaves a stranger on a recycled PID alone", () => {
		stubPlatform("linux");
		const kill = stubProcessTable({ alive: [LIVE_PID] });
		stubProcessName("postgres\n");

		expect(defaultSidecarSystem.killEngineProcess(LIVE_PID)).toBe(false);
		expect(kill).not.toHaveBeenCalledWith(LIVE_PID, "SIGKILL");
	});
});
