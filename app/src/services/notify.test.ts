/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer half of the system notifications (#1358): the opt-in is honoured
 * here, and nowhere else can honour it - the main process cannot read a
 * localStorage-backed store.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { systemNotify, NOTIFY_KINDS } from "./notify";
import { useClientSettingsStore } from "@/stores";

function stubElectron(): {
	showNotification: ReturnType<typeof vi.fn>;
	notificationAvailability: ReturnType<typeof vi.fn>;
	sendTestNotification: ReturnType<typeof vi.fn>;
} {
	const showNotification = vi.fn().mockResolvedValue("shown");
	const notificationAvailability = vi.fn().mockResolvedValue({ available: true, reason: null });
	const sendTestNotification = vi.fn().mockResolvedValue("shown");
	vi.stubGlobal("window", {
		electronAPI: { showNotification, notificationAvailability, sendTestNotification },
	});
	return { showNotification, notificationAvailability, sendTestNotification };
}

const request = {
	kind: NOTIFY_KINDS.loadRunFinished,
	title: "Load test finished",
	body: "12,400 requests, p95 210 ms, 0.3% errors",
	target: { view: "run", runId: "run_7" },
} as const;

afterEach(() => {
	useClientSettingsStore.setState({ systemNotifications: false });
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("systemNotify.post", () => {
	it("sends the request when the user asked to be notified", () => {
		const { showNotification } = stubElectron();
		useClientSettingsStore.setState({ systemNotifications: true });

		systemNotify.post({ ...request });

		expect(showNotification).toHaveBeenCalledWith({
			kind: NOTIFY_KINDS.loadRunFinished,
			title: "Load test finished",
			body: "12,400 requests, p95 210 ms, 0.3% errors",
			target: { view: "run", runId: "run_7" },
		});
	});

	it("sends nothing with the setting off - the default", () => {
		const { showNotification } = stubElectron();

		systemNotify.post({ ...request });

		// Pins the opt-in read. Drop it and every install starts posting to the
		// OS without being asked, which is the toggle's whole point.
		expect(showNotification).not.toHaveBeenCalled();
	});

	it("defaults a request with no target to the app itself", () => {
		const { showNotification } = stubElectron();
		useClientSettingsStore.setState({ systemNotifications: true });

		systemNotify.post({
			kind: NOTIFY_KINDS.signedIn,
			title: "Signed in",
			body: "Back to Vayu.",
		});

		expect(showNotification).toHaveBeenCalledWith(
			expect.objectContaining({ target: { view: "app" } })
		);
	});

	it("is a no-op outside Electron, setting or no setting", () => {
		vi.stubGlobal("window", {});
		useClientSettingsStore.setState({ systemNotifications: true });

		expect(() => systemNotify.post({ ...request })).not.toThrow();
	});

	it("swallows a rejected request - the event's toast already spoke", async () => {
		const { showNotification } = stubElectron();
		showNotification.mockRejectedValue(new Error("no window"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		useClientSettingsStore.setState({ systemNotifications: true });

		systemNotify.post({ ...request });
		await Promise.resolve();
		await Promise.resolve();

		expect(warn).toHaveBeenCalled();
	});
});

describe("systemNotify.sendTest", () => {
	it("posts when the setting is on - pressing Preview is how someone confirms it works", async () => {
		const { sendTestNotification } = stubElectron();
		sendTestNotification.mockResolvedValue("shown");
		useClientSettingsStore.setState({ systemNotifications: true });

		await expect(systemNotify.sendTest()).resolves.toBe("shown");
		expect(sendTestNotification).toHaveBeenCalledTimes(1);
	});

	it("sends nothing with the setting off - the default", async () => {
		const { sendTestNotification } = stubElectron();

		// Pins the opt-in read on this path too (#1447). The panel already
		// disables the button while the setting is off; drop this check and a
		// caller that reaches the service directly still posts past it.
		await expect(systemNotify.sendTest()).resolves.toBeNull();
		expect(sendTestNotification).not.toHaveBeenCalled();
	});

	it("passes the system's refusal through rather than smoothing it over", async () => {
		const { sendTestNotification } = stubElectron();
		sendTestNotification.mockResolvedValue("unavailable");
		useClientSettingsStore.setState({ systemNotifications: true });

		await expect(systemNotify.sendTest()).resolves.toBe("unavailable");
	});

	it("answers null outside Electron instead of throwing at the button", async () => {
		vi.stubGlobal("window", {});
		useClientSettingsStore.setState({ systemNotifications: true });

		await expect(systemNotify.sendTest()).resolves.toBeNull();
	});
});

describe("systemNotify.availability", () => {
	it("answers what the main process says", async () => {
		const { notificationAvailability } = stubElectron();
		notificationAvailability.mockResolvedValue({ available: false, reason: "nope" });

		await expect(systemNotify.availability()).resolves.toEqual({
			available: false,
			reason: "nope",
		});
	});

	it("answers null outside Electron, where the question does not arise", async () => {
		vi.stubGlobal("window", {});

		await expect(systemNotify.availability()).resolves.toBeNull();
	});
});
