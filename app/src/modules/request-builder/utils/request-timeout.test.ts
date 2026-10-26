/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Settings tab's timeout field helpers (issue #2937): what typed text
 * becomes, which setting the empty field names, and how it says so.
 */

import { describe, it, expect } from "vitest";
import { MAX_REQUEST_TIMEOUT_MS, MIN_REQUEST_TIMEOUT_MS } from "@/constants/request";
import { formatMs } from "@/lib/format-number";
import type { ConfigEntry } from "@/types";
import { defaultTimeoutFrom, parseTimeout, timeoutPlaceholder } from "./request-timeout";

const SETTING_MS = 45_000;

function entry(key: string, value: string): ConfigEntry {
	return { key, value } as ConfigEntry;
}

describe("parseTimeout", () => {
	it("keeps a number inside the engine's range", () => {
		expect(parseTimeout("1500")).toBe(1500);
		expect(parseTimeout(String(MIN_REQUEST_TIMEOUT_MS))).toBe(MIN_REQUEST_TIMEOUT_MS);
		expect(parseTimeout(String(MAX_REQUEST_TIMEOUT_MS))).toBe(MAX_REQUEST_TIMEOUT_MS);
	});

	it("clamps a number outside it, since the engine would answer a 400", () => {
		expect(parseTimeout("0")).toBe(MIN_REQUEST_TIMEOUT_MS);
		expect(parseTimeout("-20")).toBe(MIN_REQUEST_TIMEOUT_MS);
		expect(parseTimeout(String(MAX_REQUEST_TIMEOUT_MS + 1))).toBe(MAX_REQUEST_TIMEOUT_MS);
	});

	it("is null for text that is not a number, so the caller decides", () => {
		expect(parseTimeout("")).toBeNull();
		expect(parseTimeout("abc")).toBeNull();
	});
});

describe("defaultTimeoutFrom", () => {
	it("reads the defaultTimeout entry", () => {
		const entries = [entry("other", "9"), entry("defaultTimeout", String(SETTING_MS))];
		expect(defaultTimeoutFrom(entries)).toBe(SETTING_MS);
	});

	it("is null rather than a guess when the config has not arrived or lacks the entry", () => {
		expect(defaultTimeoutFrom(undefined)).toBeNull();
		expect(defaultTimeoutFrom([entry("other", "9")])).toBeNull();
		expect(defaultTimeoutFrom([entry("defaultTimeout", "soon")])).toBeNull();
	});
});

describe("timeoutPlaceholder", () => {
	it("names the setting's value in milliseconds when it is known", () => {
		expect(timeoutPlaceholder(SETTING_MS)).toBe(`Use default (${formatMs(SETTING_MS)} ms)`);
	});

	it("names no number when it is not", () => {
		expect(timeoutPlaceholder(null)).toBe("Use default");
	});
});
