/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The guard has to hold on the event the IME actually sends: same `key`, same
 * handler, `isComposing` the only thing separating "commit the buffer" from
 * "do the thing". Both halves are asserted, because a helper that returned
 * `false` for every Enter would satisfy the composition case alone.
 */

import { describe, it, expect } from "vitest";
import type { KeyboardEvent } from "react";
import { isCommitEnter } from "./keyboard";

/** The two fields the guard reads, in the shape React hands a handler. */
const keyEvent = (key: string, isComposing: boolean): KeyboardEvent =>
	({ key, nativeEvent: { isComposing } }) as KeyboardEvent;

describe("isCommitEnter", () => {
	it("accepts a plain Enter", () => {
		expect(isCommitEnter(keyEvent("Enter", false))).toBe(true);
	});

	it("refuses the Enter that commits an IME composition", () => {
		expect(isCommitEnter(keyEvent("Enter", true))).toBe(false);
	});

	it("refuses any other key, composing or not", () => {
		expect(isCommitEnter(keyEvent("Escape", false))).toBe(false);
		expect(isCommitEnter(keyEvent(" ", true))).toBe(false);
	});
});
