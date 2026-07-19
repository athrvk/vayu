/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { subscribeFocus, publishFocus } from "./chartFocus";

describe("chartFocus channel", () => {
	it("delivers the focused timestamp to subscribers of the same key", () => {
		const a = vi.fn();
		const origin = Symbol("origin");
		const unsub = subscribeFocus("g1", a);
		publishFocus("g1", 37.5, origin);
		expect(a).toHaveBeenCalledWith(37.5, origin);
		unsub();
	});

	it("does not cross group keys", () => {
		const a = vi.fn();
		const unsub = subscribeFocus("g1", a);
		publishFocus("g2", 10, Symbol());
		expect(a).not.toHaveBeenCalled();
		unsub();
	});

	it("passes origin through so a chart can ignore its own echo", () => {
		const self = Symbol("self");
		const received: symbol[] = [];
		const unsub = subscribeFocus("g", (_t, origin) => received.push(origin));
		publishFocus("g", 1, self);
		expect(received).toEqual([self]); // caller compares against its own symbol
		unsub();
	});

	it("stops delivering after unsubscribe", () => {
		const a = vi.fn();
		const unsub = subscribeFocus("g", a);
		unsub();
		publishFocus("g", 5, Symbol());
		expect(a).not.toHaveBeenCalled();
	});

	it("carries null to clear the focus", () => {
		const a = vi.fn();
		const unsub = subscribeFocus("g", a);
		publishFocus("g", null, Symbol());
		expect(a).toHaveBeenCalledWith(null, expect.any(Symbol));
		unsub();
	});
});
