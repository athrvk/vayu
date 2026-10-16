/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, it } from "vitest";
import { isLocalHost } from "./host-locality";

describe("isLocalHost", () => {
	it.each([
		"127.0.0.1",
		"localhost",
		"app.localhost",
		"10.0.0.5",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.20",
		"169.254.10.1",
		"[::1]",
		"[fd00::1]",
		"[::ffff:127.0.0.1]",
		"[::ffff:7f00:1]",
		"[::ffff:a01:203]",
	])("%s is local", (host) => {
		expect(isLocalHost(host)).toBe(true);
	});

	it.each([
		"jsonplaceholder.typicode.com",
		"8.8.8.8",
		"172.32.0.1",
		"172.15.0.1",
		"[2001:db8::1]",
		"[::ffff:808:808]",
	])("%s is not local", (host) => {
		expect(isLocalHost(host)).toBe(false);
	});
});
