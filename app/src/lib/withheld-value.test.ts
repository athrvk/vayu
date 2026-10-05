/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { WITHHELD_MARKER, holdsWithheld, isWithheld } from "./withheld-value";

describe("withheld values", () => {
	it("spells the marker the way the engine writes it", () => {
		// engine/include/vayu/utils/log_redact.hpp kRedactedMarker
		expect(WITHHELD_MARKER).toBe("<redacted>");
	});

	it("finds the marker as a whole value and as a substring", () => {
		expect(isWithheld("<redacted>")).toBe(true);
		expect(isWithheld("Bearer <redacted>")).toBe(true);
		expect(isWithheld("Bearer abc")).toBe(false);
	});

	it("finds it at any depth of a snapshot node", () => {
		expect(holdsWithheld('{"a":"<redacted>"}')).toBe(true);
		expect(holdsWithheld([{ key: "k", value: "x<redacted>y" }])).toBe(true);
		expect(holdsWithheld({ nested: { deep: ["ok", "<redacted>"] } })).toBe(true);
		expect(holdsWithheld([{ key: "k", value: "plain" }, 7, null, undefined])).toBe(false);
	});
});
