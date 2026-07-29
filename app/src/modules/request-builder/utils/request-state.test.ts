/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `createDefaultRequestState` and the Settings-tab badge predicate.
 *
 * `createDefaultRequestState` takes an optional `httpVersion` override so a
 * caller with access to the engine's `defaultHttpVersion` config can seed a
 * new draft on it, while staying pure and synchronous itself - see the
 * docblock on the function.
 *
 * `isRequestSettingsNonDefault` used to be `isRedirectPolicyNonDefault` and
 * only compared `followRedirects` / `maxRedirects`. It now also compares
 * `httpVersion`, so a request that changes only its protocol still badges the
 * Settings tab.
 */

import { describe, it, expect } from "vitest";
import { createDefaultRequestState, isRequestSettingsNonDefault } from "./request-state";
import { DEFAULT_HTTP_VERSION } from "@/constants/request";

describe("createDefaultRequestState", () => {
	it("defaults httpVersion to DEFAULT_HTTP_VERSION when no override is given", () => {
		expect(createDefaultRequestState().httpVersion).toBe(DEFAULT_HTTP_VERSION);
	});

	it("uses the given override instead of the hardcoded default", () => {
		expect(createDefaultRequestState("http2").httpVersion).toBe("http2");
	});
});

describe("isRequestSettingsNonDefault", () => {
	const defaults = {
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: DEFAULT_HTTP_VERSION,
	} as const;

	it("is false when every field matches the engine defaults", () => {
		expect(isRequestSettingsNonDefault(defaults)).toBe(false);
	});

	it("is true when followRedirects differs", () => {
		expect(isRequestSettingsNonDefault({ ...defaults, followRedirects: false })).toBe(true);
	});

	it("is true when maxRedirects differs", () => {
		expect(isRequestSettingsNonDefault({ ...defaults, maxRedirects: 5 })).toBe(true);
	});

	it("is true when httpVersion differs, even with both redirect fields at their defaults", () => {
		// This is the case the rename exists for: a request that only changes
		// its protocol must still badge the Settings tab.
		expect(isRequestSettingsNonDefault({ ...defaults, httpVersion: "http2" })).toBe(true);
	});
});
