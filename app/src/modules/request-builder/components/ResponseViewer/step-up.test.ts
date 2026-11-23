/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { stepUpChallenges } from "./step-up";

const CHALLENGE = 'Bearer error="insufficient_scope", scope="mcp:write"';

describe("stepUpChallenges", () => {
	it("reads every WWW-Authenticate line of a 403, whatever the name's case", () => {
		expect(
			stepUpChallenges({
				status: 403,
				headers: {},
				headerLines: [
					{ name: "WWW-Authenticate", value: 'Basic realm="x"' },
					{ name: "content-type", value: "application/json" },
					{ name: "www-authenticate", value: CHALLENGE },
				],
			})
		).toEqual(['Basic realm="x"', CHALLENGE]);
	});

	it("falls back to the folded map when the engine recorded no lines", () => {
		expect(
			stepUpChallenges({ status: 403, headers: { "www-authenticate": CHALLENGE } })
		).toEqual([CHALLENGE]);
	});

	it.each([
		["a 401", 401],
		["a 200", 200],
	])("asks nothing about %s, which is not a step-up", (_case, status) => {
		expect(stepUpChallenges({ status, headers: { "www-authenticate": CHALLENGE } })).toEqual(
			[]
		);
	});

	it("asks nothing about a 403 with no challenge", () => {
		expect(
			stepUpChallenges({ status: 403, headers: { "content-type": "text/plain" } })
		).toEqual([]);
	});
});
