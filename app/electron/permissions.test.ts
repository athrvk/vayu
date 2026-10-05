/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { denyDevicePermissions, isPermissionAllowed } from "./permissions.js";

function fakeSession() {
	let request: ((wc: unknown, p: string, cb: (granted: boolean) => void) => void) | undefined;
	let check: ((wc: unknown, p: string) => boolean) | undefined;
	return {
		setPermissionRequestHandler: vi.fn((h) => (request = h)),
		setPermissionCheckHandler: vi.fn((h) => (check = h)),
		asked(permission: string): boolean {
			const callback = vi.fn();
			request?.(null, permission, callback);
			return callback.mock.calls[0][0] as boolean;
		},
		checked: (permission: string) => check?.(null, permission) as boolean,
	};
}

describe("denyDevicePermissions", () => {
	const denied = ["camera", "microphone", "geolocation", "notifications", "media"];

	it.each(denied)("denies a request for %s", (permission) => {
		const session = fakeSession();
		denyDevicePermissions(session as never);
		expect(session.asked(permission)).toBe(false);
	});

	it.each(denied)("answers a check for %s with no", (permission) => {
		const session = fakeSession();
		denyDevicePermissions(session as never);
		expect(session.checked(permission)).toBe(false);
	});

	it("grants only the sanitized clipboard write", () => {
		const session = fakeSession();
		denyDevicePermissions(session as never);
		expect(session.asked("clipboard-sanitized-write")).toBe(true);
		expect(isPermissionAllowed("clipboard-read")).toBe(false);
	});
});
