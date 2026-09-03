/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a pre-#1229 client wrote, and how narrowly it is recognised.
 *
 * Until issue #1229 this module *created* `User-Agent`, `X-Vayu-Version` and a
 * fresh `X-Request-ID`, seeded them into every new request, and saved them with
 * it. The engine adds those at send time now, so the only job left here is
 * recognising the rows the old client left behind - and the danger has inverted:
 * the old code could not delete a user's header, this one can. So every case
 * below is paired, one row dropped against a lookalike kept.
 *
 * Mirror of `strip_legacy_managed_headers` in
 * `engine/src/http/default_headers.cpp`, which does the same to the stored copy
 * at startup. The two rules must stay identical; a divergence shows up as a
 * header the editor hides and the engine still sends.
 */

import { describe, it, expect } from "vitest";
import { isLegacyManagedHeader, toHeaderItems } from "./system-headers";
import { createDefaultRequestState } from "./request-state";

describe("the rows a pre-#1229 client wrote", () => {
	it("drops X-Vayu-Version whatever its value, since none of it was ever the user's", () => {
		const rows = toHeaderItems([
			{ key: "X-Vayu-Version", value: "0.9.0", enabled: true },
			{ key: "Accept", value: "*/*", enabled: true },
		]);

		expect(rows.map((r) => r.key)).not.toContain("X-Vayu-Version");
		expect(rows.map((r) => r.key)).toContain("Accept");
	});

	it("drops an X-Request-ID whose value is a bare UUID - the shape it generated", () => {
		const rows = toHeaderItems([
			{ key: "X-Request-ID", value: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", enabled: true },
		]);

		expect(rows.map((r) => r.key)).not.toContain("X-Request-ID");
	});

	it("keeps a hand-typed X-Request-ID, which is a correlation id someone meant", () => {
		const rows = toHeaderItems([{ key: "X-Request-ID", value: "order-42", enabled: true }]);

		expect(rows.find((r) => r.key === "X-Request-ID")?.value).toBe("order-42");
	});

	it("drops a Vayu/... User-Agent", () => {
		const rows = toHeaderItems([{ key: "User-Agent", value: "Vayu/0.9.0", enabled: true }]);

		expect(rows.map((r) => r.key)).not.toContain("User-Agent");
	});

	it("keeps a browser User-Agent, which is the header a testing tool exists to send", () => {
		const agent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
		const rows = toHeaderItems([{ key: "User-Agent", value: agent, enabled: true }]);

		expect(rows.find((r) => r.key === "User-Agent")?.value).toBe(agent);
	});

	it("matches the name case-insensitively, as HTTP does", () => {
		expect(isLegacyManagedHeader("x-vayu-VERSION", "0.9.0")).toBe(true);
		expect(isLegacyManagedHeader("user-agent", "VAYU/0.9.0")).toBe(true);
	});

	it("leaves every other header alone", () => {
		const rows = toHeaderItems([
			{ key: "Accept", value: "application/json", enabled: true },
			{ key: "X-Trace", value: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", enabled: true },
		]);

		expect(rows.map((r) => r.key)).toEqual(["Accept", "X-Trace", ""]);
	});
});

describe("the editor rows themselves", () => {
	it("ends with exactly one blank row to type into", () => {
		const rows = toHeaderItems([{ key: "Accept", value: "*/*", enabled: true }]);

		expect(rows[rows.length - 1]).toMatchObject({ key: "", value: "" });
		expect(rows.filter((r) => !r.key && !r.value)).toHaveLength(1);
	});

	it("gives every row a distinct id, since they are the table's React keys", () => {
		const rows = toHeaderItems([
			{ key: "Accept", value: "*/*", enabled: true },
			{ key: "Accept-Language", value: "en", enabled: true },
		]);

		expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
	});

	it("seeds a new request with no Vayu row at all - only the blank one", () => {
		// The defect this replaces: `createDefaultSystemHeaders()` put three rows
		// here, which the first save then wrote into the stored request.
		const fresh = createDefaultRequestState();

		expect(fresh.headers).toEqual([expect.objectContaining({ key: "", value: "" })]);
		expect(fresh.disabledDefaultHeaders).toEqual([]);
	});
});
