/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const config = JSON.parse(
	readFileSync(path.resolve(__dirname, "../electron-builder.json"), "utf8")
) as { electronFuses?: Record<string, boolean> };

describe("electron-builder electronFuses (#1780)", () => {
	it("turns off the Node escape hatches and checks the ASAR", () => {
		expect(config.electronFuses).toMatchObject({
			runAsNode: false,
			enableNodeOptionsEnvironmentVariable: false,
			enableNodeCliInspectArguments: false,
			onlyLoadAppFromAsar: true,
			enableEmbeddedAsarIntegrityValidation: true,
		});
	});

	it("keeps cookie encryption off while the mock keychain is set", () => {
		expect(config.electronFuses?.enableCookieEncryption).toBe(false);
	});

	it("gives file: pages no privileges beyond a browser's, since the app loads none (#2380)", () => {
		// The renderer is served from the app scheme (app-protocol.ts); the key is
		// electron-builder 26's name for Electron's GrantFileProtocolExtraPrivileges.
		expect(config.electronFuses?.grantFileProtocolExtraPrivileges).toBe(false);
	});
});
