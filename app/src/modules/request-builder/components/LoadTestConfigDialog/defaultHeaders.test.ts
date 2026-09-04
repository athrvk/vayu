/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { describeDefaultHeaderDifference } from "./defaultHeaders";
import type { RequestDefaults } from "@/types";

function defaults(headers: RequestDefaults["headers"]): RequestDefaults {
	return { headers };
}

const userAgent = { name: "User-Agent", value: "Vayu/1.0", generated: false };
const acceptEncodingOn = { name: "Accept-Encoding", value: "gzip, br", generated: false };

describe("describeDefaultHeaderDifference", () => {
	it("is null while either scope has not answered yet", () => {
		expect(describeDefaultHeaderDifference(undefined, undefined)).toBeNull();
		expect(describeDefaultHeaderDifference(defaults([userAgent]), undefined)).toBeNull();
		expect(describeDefaultHeaderDifference(undefined, defaults([userAgent]))).toBeNull();
	});

	it("is null when the two scopes declare the same set", () => {
		expect(
			describeDefaultHeaderDifference(
				defaults([userAgent, acceptEncodingOn]),
				defaults([userAgent, acceptEncodingOn])
			)
		).toBeNull();
	});

	it("names a header compression turns off for a load run (issue #1338)", () => {
		// negotiateCompression: true, loadNegotiateCompression: false - the exact
		// scenario the issue reports: the Headers tab shows Accept-Encoding, and
		// a load run of the same request would not send it.
		const line = describeDefaultHeaderDifference(
			defaults([userAgent, acceptEncodingOn]),
			defaults([userAgent])
		);
		expect(line).toMatch(/Accept-Encoding/);
		expect(line).toMatch(/Headers tab/i);
		expect(line).toMatch(/not on this load run/i);
	});

	it("names a header a load run adds that the Headers tab does not", () => {
		const line = describeDefaultHeaderDifference(
			defaults([userAgent]),
			defaults([userAgent, acceptEncodingOn])
		);
		expect(line).toMatch(/Accept-Encoding/);
		expect(line).toMatch(/not on the Headers tab/i);
	});

	it("names a header whose value differs between the two scopes", () => {
		const line = describeDefaultHeaderDifference(
			defaults([{ name: "Accept-Encoding", value: "gzip, br", generated: false }]),
			defaults([{ name: "Accept-Encoding", value: "gzip", generated: false }])
		);
		expect(line).toMatch(/Accept-Encoding/);
		expect(line).toMatch(/different value/i);
	});

	it("joins more than one differing header into the same line", () => {
		const line = describeDefaultHeaderDifference(
			defaults([userAgent, acceptEncodingOn]),
			defaults([userAgent])
		);
		// Single-header case above already covers the wording; this only pins
		// that a second name would not be dropped silently.
		const withSecond = describeDefaultHeaderDifference(
			defaults([
				userAgent,
				acceptEncodingOn,
				{ name: "X-Extra", value: "a", generated: false },
			]),
			defaults([userAgent])
		);
		expect(withSecond).toMatch(/Accept-Encoding, X-Extra/);
		expect(line).not.toMatch(/X-Extra/);
	});

	it("treats a generated header with no value yet as unchanged", () => {
		// `generated: true` headers carry no `value` until a send makes one -
		// both sides read `undefined` and must not be reported as "differs".
		const generated = { name: "X-Correlation-Id", generated: true };
		expect(
			describeDefaultHeaderDifference(defaults([generated]), defaults([generated]))
		).toBeNull();
	});
});
