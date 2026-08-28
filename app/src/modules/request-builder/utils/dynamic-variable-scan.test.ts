/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, it } from "vitest";
import { requestUsesDynamicVariables } from "./dynamic-variable-scan";
import type { KeyValueItem } from "@/types";

const kv = (key: string, value: string, enabled = true): KeyValueItem => ({
	id: `${key}-${value}`,
	key,
	value,
	enabled,
});

const request = (over: Partial<Parameters<typeof requestUsesDynamicVariables>[0]> = {}) => ({
	url: "https://api.test/orders",
	headers: [] as KeyValueItem[],
	body: "",
	formData: [] as KeyValueItem[],
	urlEncoded: [] as KeyValueItem[],
	...over,
});

describe("requestUsesDynamicVariables", () => {
	it("is false for a request with none, and for no request at all", () => {
		expect(requestUsesDynamicVariables(request())).toBe(false);
		expect(requestUsesDynamicVariables(null)).toBe(false);
	});

	it("finds one in the URL, body, headers, form-data or url-encoded fields", () => {
		expect(requestUsesDynamicVariables(request({ url: "https://x/{{$guid}}" }))).toBe(true);
		expect(requestUsesDynamicVariables(request({ body: '{"at":"{{$isoTimestamp}}"}' }))).toBe(
			true
		);
		expect(
			requestUsesDynamicVariables(request({ headers: [kv("X-Trace", "{{$guid}}")] }))
		).toBe(true);
		expect(
			requestUsesDynamicVariables(request({ formData: [kv("id", "{{$randomInt}}")] }))
		).toBe(true);
		expect(
			requestUsesDynamicVariables(request({ urlEncoded: [kv("id", "{{$randomUUID}}")] }))
		).toBe(true);
	});

	it("finds one written in a key, not just a value", () => {
		expect(
			requestUsesDynamicVariables(request({ headers: [kv("X-{{$randomInt}}", "1")] }))
		).toBe(true);
	});

	it("ignores a disabled row - it is never sent, so nothing is generated", () => {
		expect(
			requestUsesDynamicVariables(request({ headers: [kv("X-Trace", "{{$guid}}", false)] }))
		).toBe(false);
	});

	it("ignores ordinary variables and unknown generators", () => {
		// An unknown `$name` is left written as it stands, so no value is
		// generated and there is nothing to warn about.
		expect(requestUsesDynamicVariables(request({ url: "{{baseUrl}}/orders" }))).toBe(false);
		expect(requestUsesDynamicVariables(request({ url: "{{$randomInteger}}" }))).toBe(false);
	});

	it("does not warn for $vu / $iteration (issue #994) - the whole point of the two is that a run rebinds them per iteration, unlike a generator", () => {
		expect(
			requestUsesDynamicVariables(
				request({ url: "https://api.test/u{{$vu}}/i{{$iteration}}" })
			)
		).toBe(false);
		expect(requestUsesDynamicVariables(request({ headers: [kv("X-VU", "{{$vu}}")] }))).toBe(
			false
		);
		// The other direction, in the same request: a real generator alongside
		// them still trips the warning - the scan is not simply disabled for a
		// request that also happens to carry these two.
		expect(
			requestUsesDynamicVariables(
				request({ url: "https://api.test/u{{$vu}}", body: '{"id":"{{$guid}}"}' })
			)
		).toBe(true);
	});
});
