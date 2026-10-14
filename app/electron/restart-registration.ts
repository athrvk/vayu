/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Asking Windows to start Vayu again after a restart (issue #2098).
 *
 * Windows reopens the apps that were running when the user restarts the machine
 * for an update (or restarts with "Restart apps" signed in), but only the ones
 * that registered with `RegisterApplicationRestart`. Electron does not, and
 * `setLoginItemSettings` is the wrong tool: it starts the app at every sign-in,
 * which the user switches on and off by itself in Settings.
 *
 * The call is made through `koffi`, a prebuilt FFI binding, because Electron has
 * no API for it. Everything that can fail is therefore optional: a missing
 * binding, a platform package that was not installed or a call Windows refuses
 * costs the user the restart and nothing else, so none of it may reach the
 * caller. `koffi` is imported on Windows only; elsewhere it is never loaded.
 *
 * Windows restarts only an app that had been running for at least a minute when
 * the session ended, with the arguments registered here and none of the original
 * ones. The relaunch is an ordinary launch: the window opens and the
 * single-instance lock is taken like any other (`docs/architecture.md`).
 *
 * Kept out of main.ts so it can be tested - the binding arrives as `load`, the
 * same seam `login-item.ts` leaves for Electron.
 */

/** The argument Windows relaunches the app with. `open-intent.ts` ignores it. */
export const RESTARTED_AFTER_REBOOT_ARG = "--restarted-after-reboot";

/*
 * `RegisterApplicationRestart` flags. They name the cases NOT to restart for,
 * and the three set here each belong to another subsystem: a crash or a hang of
 * the main process is not something to answer with a second launch
 * (`renderer-recovery.ts` recovers the renderer in place), and an update in
 * progress is the updater's relaunch. `RESTART_NO_REBOOT` (8) stays clear: it
 * is the case this exists for.
 */
const RESTART_NO_CRASH = 1;
const RESTART_NO_HANG = 2;
const RESTART_NO_PATCH = 4;
const RESTART_FLAGS = RESTART_NO_CRASH | RESTART_NO_HANG | RESTART_NO_PATCH;

/** The slice of `koffi` this uses, so a test can supply a fake and the real package stays typed. */
export interface KoffiBinding {
	load(path: string): {
		func(
			convention: string,
			name: string,
			result: string,
			parameters: string[]
		): (commandLine: string, flags: number) => number;
	};
}

export interface RestartRegistrationDeps {
	platform: NodeJS.Platform;
	/** `app.isPackaged`. A dev run's executable is Electron's own, which must not be restarted. */
	isPackaged: boolean;
	/** `() => import("koffi")`. Called only when a registration will be attempted. */
	load: () => Promise<KoffiBinding>;
	/** Where a failure is reported. Category `"main"`, level warn. */
	log: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Whether Windows launched this process through the restart registered above. */
export function wasRestartedAfterReboot(argv: readonly string[]): boolean {
	return argv.includes(RESTARTED_AFTER_REBOOT_ARG);
}

/**
 * Registers the app for Windows' restart-after-reboot. Never rejects.
 *
 * A packaged Windows build only: anywhere else `load` is not called.
 */
export async function registerForRestart(deps: RestartRegistrationDeps): Promise<void> {
	if (deps.platform !== "win32" || !deps.isPackaged) return;

	try {
		const koffi = await deps.load();
		const registerApplicationRestart = koffi
			.load("kernel32.dll")
			// `str16` is the UTF-16 string `PCWSTR` takes. The return is an HRESULT.
			.func("__stdcall", "RegisterApplicationRestart", "int32", ["str16", "uint32"]);
		const result = registerApplicationRestart(RESTARTED_AFTER_REBOOT_ARG, RESTART_FLAGS);
		if (result !== 0) {
			deps.log("Windows refused the restart registration", { hresult: result });
		}
	} catch (error) {
		deps.log("Could not register for restart after a reboot", { error: String(error) });
	}
}
