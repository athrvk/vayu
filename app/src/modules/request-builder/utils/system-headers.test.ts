/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `toHeaderItems` - the seam where the request builder's managed headers meet
 * the shared table's row conversion.
 *
 * It was `toKeyValueItems(entries, true)` until the conversion moved to
 * `components/shared/KeyValueEditor` (issue #567) and the system headers stayed
 * behind, so this pins the three parts of the behaviour that crossed that seam:
 * the managed rows come first, a stored entry that collides with one is
 * dropped, and the list still ends in the table's single blank row.
 */

import { describe, it, expect } from "vitest";
import { toHeaderItems, SYSTEM_HEADER_KEYS } from "./system-headers";

describe("toHeaderItems", () => {
	it("puts the managed system headers in front of the stored ones", () => {
		const rows = toHeaderItems([{ key: "Accept", value: "application/json", enabled: true }]);

		expect(rows.slice(0, 3).map((r) => r.key)).toEqual([
			"User-Agent",
			"X-Vayu-Version",
			"X-Request-ID",
		]);
		expect(rows.slice(0, 3).every((r) => r.system)).toBe(true);
		expect(rows[3]).toMatchObject({ key: "Accept", value: "application/json" });
	});

	it("drops a stored entry whose key collides with a managed one, whatever its case", () => {
		const rows = toHeaderItems([
			{ key: "user-agent", value: "curl/8.0", enabled: true },
			{ key: "Accept", value: "*/*", enabled: true },
		]);

		expect(rows.filter((r) => r.key.toLowerCase() === "user-agent")).toHaveLength(1);
		expect(rows.find((r) => r.key === "User-Agent")?.value).toMatch(/^Vayu\//);
		expect(rows.map((r) => r.key)).toContain("Accept");
	});

	it("ends with exactly one blank row to type into", () => {
		const rows = toHeaderItems([{ key: "Accept", value: "*/*", enabled: true }]);
		const last = rows[rows.length - 1];

		expect(last).toMatchObject({ key: "", value: "" });
		expect(rows.filter((r) => !r.key && !r.value)).toHaveLength(1);
	});

	it("gives every row a distinct id, since they are the table's React keys", () => {
		const rows = toHeaderItems([
			{ key: "Accept", value: "*/*", enabled: true },
			{ key: "Accept-Language", value: "en", enabled: true },
		]);

		expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
	});

	it("names the same managed keys the rest of the module guards", () => {
		// The filter above reads `createDefaultSystemHeaders`, not this set, so a
		// managed header added to one and not the other would be droppable here
		// and undeletable there.
		const managed = toHeaderItems([])
			.filter((r) => r.system)
			.map((r) => r.key.toLowerCase());

		expect(new Set(managed)).toEqual(SYSTEM_HEADER_KEYS);
	});
});
