/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, it } from "vitest";
import type { LogFileRecord } from "@/types/electron";
import { LEVEL_TONE } from "./console-level";

describe("LEVEL_TONE", () => {
	it("has a tone for every level a log record carries, beside the console's", () => {
		// A `Record` over the record's levels: a level added to the type and missing
		// here is a type error, one added here and missing from the table is red.
		const recordLevels: Record<LogFileRecord["level"], true> = {
			debug: true,
			info: true,
			warn: true,
			error: true,
		};
		for (const level of Object.keys(recordLevels)) {
			expect(LEVEL_TONE).toHaveProperty(level);
		}
		expect(LEVEL_TONE.log.gutter).toBe("");
	});

	it("draws debug in the muted tones, with its own word in the gutter", () => {
		expect(LEVEL_TONE.debug).toEqual({
			gutter: "debug",
			text: "text-muted-foreground",
			label: "text-muted-foreground",
		});
	});
});
