/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Windows restart registration (#2098).
 *
 * Two things matter: it is attempted only where it can mean something - a
 * packaged Windows build, with `koffi` never loaded anywhere else - and it can
 * never throw into the startup handler that calls it. The platform is injected;
 * nothing here reads the host's.
 */

import { describe, expect, it, vi } from "vitest";
import {
	RESTARTED_AFTER_REBOOT_ARG,
	registerForRestart,
	wasRestartedAfterReboot,
	type KoffiBinding,
} from "./restart-registration.js";

function fakeKoffi(result = 0) {
	const registerApplicationRestart = vi.fn((_commandLine: string, _flags: number) => result);
	const func = vi.fn(
		(_convention: string, _name: string, _result: string, _parameters: string[]) =>
			registerApplicationRestart
	);
	const loadLibrary = vi.fn((_path: string) => ({ func }));
	const binding: KoffiBinding = { load: loadLibrary };
	return { binding, loadLibrary, func, registerApplicationRestart };
}

function setup(
	options: {
		platform?: NodeJS.Platform;
		isPackaged?: boolean;
		result?: number;
		load?: () => Promise<KoffiBinding>;
	} = {}
) {
	const koffi = fakeKoffi(options.result);
	const load = vi.fn(options.load ?? (() => Promise.resolve(koffi.binding)));
	const log = vi.fn();
	const run = () =>
		registerForRestart({
			platform: options.platform ?? "win32",
			isPackaged: options.isPackaged ?? true,
			load,
			log,
		});
	return { ...koffi, load, log, run };
}

describe("registerForRestart", () => {
	it("registers the relaunch argument with the no-crash, no-hang, no-patch flags on a packaged Windows build", async () => {
		const { run, load, loadLibrary, func, registerApplicationRestart, log } = setup();

		await run();

		expect(load).toHaveBeenCalledTimes(1);
		expect(loadLibrary).toHaveBeenCalledWith("kernel32.dll");
		expect(func).toHaveBeenCalledWith("__stdcall", "RegisterApplicationRestart", "int32", [
			"str16",
			"uint32",
		]);
		expect(registerApplicationRestart).toHaveBeenCalledTimes(1);
		// 1 (no crash) | 2 (no hang) | 4 (no patch); 8 (no reboot) is the case this is for.
		expect(registerApplicationRestart).toHaveBeenCalledWith("--restarted-after-reboot", 7);
		expect(log).not.toHaveBeenCalled();
	});

	it.each<NodeJS.Platform>(["darwin", "linux"])(
		"never loads the binding on %s",
		async (platform) => {
			const { run, load, log } = setup({ platform });

			await run();

			expect(load).not.toHaveBeenCalled();
			expect(log).not.toHaveBeenCalled();
		}
	);

	it("never loads the binding from an unpackaged run", async () => {
		const { run, load, log } = setup({ isPackaged: false });

		await run();

		expect(load).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
	});

	it("resolves, and logs once, when the binding fails to load", async () => {
		const { run, log, registerApplicationRestart } = setup({
			load: () => Promise.reject(new Error("Cannot find module 'koffi'")),
		});

		await expect(run()).resolves.toBeUndefined();

		expect(registerApplicationRestart).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0][1]).toEqual({ error: "Error: Cannot find module 'koffi'" });
	});

	it("resolves, and logs once, when the load throws before returning a promise", async () => {
		const { run, log } = setup({
			load: () => {
				throw new Error("boom");
			},
		});

		await expect(run()).resolves.toBeUndefined();

		expect(log).toHaveBeenCalledTimes(1);
	});

	it("resolves, and logs once, when kernel32 cannot be called", async () => {
		const koffi = fakeKoffi();
		koffi.loadLibrary.mockImplementation(() => {
			throw new Error("The specified module could not be found");
		});
		const log = vi.fn();

		await expect(
			registerForRestart({
				platform: "win32",
				isPackaged: true,
				load: () => Promise.resolve(koffi.binding),
				log,
			})
		).resolves.toBeUndefined();

		expect(log).toHaveBeenCalledTimes(1);
	});

	it("logs the HRESULT when Windows refuses the registration", async () => {
		const { run, log } = setup({ result: -2147024809 });

		await expect(run()).resolves.toBeUndefined();

		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0][1]).toEqual({ hresult: -2147024809 });
	});
});

describe("wasRestartedAfterReboot", () => {
	it("is true when Windows relaunched the app with the registered argument", () => {
		expect(wasRestartedAfterReboot(["Vayu.exe", RESTARTED_AFTER_REBOOT_ARG])).toBe(true);
	});

	it("is false for an ordinary launch", () => {
		expect(wasRestartedAfterReboot(["Vayu.exe"])).toBe(false);
		expect(wasRestartedAfterReboot(["Vayu.exe", "spec.json"])).toBe(false);
	});
});
