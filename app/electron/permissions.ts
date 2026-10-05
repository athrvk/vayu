/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Deny-all device permissions (#1780).
 *
 * Electron grants every `permissionRequest` when a session has no handler.
 * Vayu needs none of them, and the OAuth window loads identity-provider pages
 * that are not ours, so a page there could otherwise be granted camera,
 * microphone or geolocation (OS prompts aside). The one exception is the
 * sanitized clipboard write that the copy buttons use.
 */

import type { Session } from "electron";

const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(["clipboard-sanitized-write"]);

/** Whether a permission is one the app grants. */
export function isPermissionAllowed(permission: string): boolean {
	return ALLOWED_PERMISSIONS.has(permission);
}

/** Install the request and check handlers on a session. */
export function denyDevicePermissions(
	target: Pick<Session, "setPermissionRequestHandler" | "setPermissionCheckHandler">
): void {
	target.setPermissionRequestHandler((_webContents, permission, callback) => {
		callback(isPermissionAllowed(permission));
	});
	target.setPermissionCheckHandler((_webContents, permission) => isPermissionAllowed(permission));
}
