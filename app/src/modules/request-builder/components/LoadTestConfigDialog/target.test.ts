/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { classifyTarget } from "./target";

describe("classifyTarget", () => {
	it.each([
		["https://api.example.com/v1/orders", "api.example.com", false],
		["http://localhost:3000/x", "localhost", true],
		["http://192.168.1.20:8080/", "192.168.1.20", true],
		["http://[::1]:8080/", "[::1]", true],
		// URL reports the mapped form as `[::ffff:7f00:1]`, not the typed dotted quad.
		["http://[::ffff:127.0.0.1]:3000/", "[::ffff:7f00:1]", true],
		["https://user:secret@Api.Example.com/x", "api.example.com", false],
		// Sent as http when no scheme is typed, not read as a `localhost:` scheme.
		["localhost:3000/x", "localhost", true],
		["api.example.com/x", "api.example.com", false],
		["https://api.example.com/users/{{id}}?q={{term}}", "api.example.com", false],
	])("%s -> %s", (url, host, isLocal) => {
		expect(classifyTarget(url)).toEqual({ kind: "host", host, isLocal });
	});

	it.each([
		["{{baseUrl}}/orders", "baseUrl"],
		["https://{{ baseUrl }}/orders", "baseUrl"],
		["https://{{sub}}.{{domain}}/x", "sub"],
		["https://api.example.com:{{port}}/x", "port"],
	])("%s has no host: the first unresolved variable is %s", (url, variable) => {
		expect(classifyTarget(url)).toEqual({ kind: "unknown", variable });
	});

	it.each(["", "   ", "http://"])("%j has no host and nothing to blame", (url) => {
		expect(classifyTarget(url)).toEqual({ kind: "unknown", variable: null });
	});
});
