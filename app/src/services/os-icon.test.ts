/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer half of the Dock/taskbar icon (#1364). What each platform
 * paints, and whether it may at all, is `electron/os-icon.ts`'s question; this
 * side only says what happened.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { osIcon } from "./os-icon";
import { useClientSettingsStore } from "@/stores";
import type { OsIconSignal } from "@/types/electron";

function stubBridge() {
	const setOsIconSignal = vi.fn<(signal: OsIconSignal) => void>();
	vi.stubGlobal("window", { electronAPI: { setOsIconSignal } });
	return setOsIconSignal;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	// The store is a module singleton, and its default is off (#1358).
	useClientSettingsStore.setState({ systemNotifications: false });
});

describe("osIcon", () => {
	it("sends a capture", () => {
		const send = stubBridge();
		osIcon.captured();
		expect(send).toHaveBeenCalledWith({ kind: "captured" });
	});

	it("sends that the Inbox opened", () => {
		const send = stubBridge();
		osIcon.inboxOpened();
		expect(send).toHaveBeenCalledWith({ kind: "inboxOpened" });
	});

	it("sends a run failure", () => {
		const send = stubBridge();
		osIcon.runFailed();
		expect(send).toHaveBeenCalledWith({ kind: "runFailed" });
	});

	/*
	 * The quieter cue for a run that ended, and the only signal here with a
	 * condition on it: it substitutes for the system notification rather than
	 * accompanying it. Mutation check: drop the opt-in read in `runFinished`
	 * and the second case sends anyway, giving a user who asked to be notified
	 * a flashing taskbar button on top of the toast they already got.
	 */
	it("sends that a run ended when the notifications it replaces are off", () => {
		useClientSettingsStore.setState({ systemNotifications: false });
		const send = stubBridge();
		osIcon.runFinished();
		expect(send).toHaveBeenCalledWith({ kind: "runFinished" });
	});

	it("says nothing about a run ending when the user opted into notifications", () => {
		useClientSettingsStore.setState({ systemNotifications: true });
		const send = stubBridge();
		osIcon.runFinished();
		expect(send).not.toHaveBeenCalled();
	});

	/*
	 * Mutation check: drop the fingerprint comparison in `recents` and the
	 * second call below - the same list, resent - shows up as a third message,
	 * which is exactly the send-on-every-navigation this guards against.
	 */
	it("sends a recents list once, and only again when it changes", () => {
		const send = stubBridge();
		osIcon.recents([{ id: "c1", name: "Acme" }]);
		osIcon.recents([{ id: "c1", name: "Acme" }]);
		osIcon.recents([{ id: "c1", name: "Beta" }]);
		expect(send.mock.calls.map(([signal]) => signal)).toEqual([
			{ kind: "recents", collections: [{ id: "c1", name: "Acme" }] },
			{ kind: "recents", collections: [{ id: "c1", name: "Beta" }] },
		]);
	});

	it("does nothing outside Electron", () => {
		vi.stubGlobal("window", {});
		expect(() => osIcon.captured()).not.toThrow();
	});

	it("logs a send that throws rather than raising it at the caller", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal("window", {
			electronAPI: {
				setOsIconSignal: () => {
					throw new Error("bridge is gone");
				},
			},
		});
		expect(() => osIcon.captured()).not.toThrow();
		expect(warn).toHaveBeenCalled();
	});
});
