/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `bodyModeHeaders` names the flat headers whose winning row the body mode
 * wrote (issue #1765), so the engine can tell the body's own Content-Type,
 * which a `content-type` opt-out removes, from one the user typed.
 */

import { describe, it, expect } from "vitest";
import type { KeyValueItem } from "@/types";
import { bodyModeHeaders, toFlatHeaders } from "./key-value";

const row = (key: string, extra: Partial<KeyValueItem> = {}): KeyValueItem => ({
	id: key,
	key,
	value: "v",
	enabled: true,
	...extra,
});

describe("bodyModeHeaders", () => {
	it("names a marked row and leaves the field out when there is none", () => {
		expect(bodyModeHeaders([row("Content-Type", { source: "body-mode" }), row("X-A")])).toEqual(
			{ bodyModeHeaders: ["Content-Type"] }
		);
		expect(bodyModeHeaders([row("Content-Type"), row("Accept", { source: "stream" })])).toEqual(
			{}
		);
	});

	it("follows the row toFlatHeaders sends: the last enabled one wins", () => {
		// Mutation check: mark by any row rather than the winning one and the
		// typed row that wins here is reported as the body mode's.
		const typedWins = [row("Content-Type", { source: "body-mode" }), row("Content-Type")];
		expect(toFlatHeaders(typedWins)).toEqual({ "Content-Type": "v" });
		expect(bodyModeHeaders(typedWins)).toEqual({});
		const disabledTyped = [
			row("Content-Type", { source: "body-mode" }),
			row("Content-Type", { enabled: false }),
		];
		expect(bodyModeHeaders(disabledTyped)).toEqual({ bodyModeHeaders: ["Content-Type"] });
	});
});
