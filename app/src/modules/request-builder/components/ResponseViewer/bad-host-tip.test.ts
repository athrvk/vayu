/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A host that is a `{{variable}}` nothing defines reaches the engine as
 * `http://{{host}}/`, and libcurl's "Bad hostname" names neither the variable
 * nor the fact that it was one (#3500). The tip reads the names off the URL the
 * user wrote.
 *
 * Mutation check: read the whole URL instead of its host (drop the `AUTHORITY`
 * match) and the path-variable cases fail; stop skipping `$` names and the
 * generator case fails.
 */

import { describe, expect, it } from "vitest";
import { badHostTip, hostVariables } from "./bad-host-tip";

describe("hostVariables", () => {
	it("reads the variable out of a host, with or without a scheme", () => {
		expect(hostVariables("https://{{host}}/pets")).toEqual(["host"]);
		expect(hostVariables("{{host}}/pets")).toEqual(["host"]);
		expect(hostVariables("http://{{ host }}:8080/pets")).toEqual(["host"]);
		expect(hostVariables("https://api.{{region}}.example.com")).toEqual(["region"]);
	});

	it("reads every variable in the host once, in order", () => {
		expect(hostVariables("https://{{sub}}.{{domain}}.{{sub}}/x")).toEqual(["sub", "domain"]);
	});

	it("leaves out the path, the query, the fragment and the userinfo", () => {
		expect(hostVariables("https://example.com/{{id}}")).toEqual([]);
		expect(hostVariables("https://example.com?q={{term}}")).toEqual([]);
		expect(hostVariables("https://example.com#{{anchor}}")).toEqual([]);
		expect(hostVariables("https://{{user}}:{{pass}}@example.com/")).toEqual([]);
		expect(hostVariables("https://{{user}}@{{host}}/")).toEqual(["host"]);
	});

	it("leaves out a generator, which always resolves", () => {
		expect(hostVariables("https://{{$guid}}.example.com")).toEqual([]);
	});

	it("finds nothing in a host that names none", () => {
		expect(hostVariables("https://example.com/pets")).toEqual([]);
		expect(hostVariables("")).toEqual([]);
	});
});

describe("badHostTip", () => {
	it("names the one variable in the host", () => {
		expect(badHostTip("https://{{host}}/pets")).toBe(
			"The host uses {{host}}. If that variable isn't defined, the host is sent as written and isn't a valid name - define it in the active environment or globals."
		);
	});

	it("names several, and agrees with their number", () => {
		const two = badHostTip("https://{{sub}}.{{domain}}/");
		expect(two).toMatch(
			/^The host uses \{\{sub\}\} and \{\{domain\}\}\. If any of those variables/
		);
		const three = badHostTip("https://{{a}}.{{b}}.{{c}}/");
		expect(three).toContain("{{a}}, {{b}}, and {{c}}");
	});

	it("says nothing for a host with no variable, or no URL", () => {
		expect(badHostTip("https://example.com/{{id}}")).toBeUndefined();
		expect(badHostTip(undefined)).toBeUndefined();
		expect(badHostTip("")).toBeUndefined();
	});
});
