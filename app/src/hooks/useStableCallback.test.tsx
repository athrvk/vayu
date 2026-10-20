/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useStableCallback } from "./useStableCallback";

describe("useStableCallback", () => {
	it("keeps one identity while the function it wraps changes", () => {
		const { result, rerender } = renderHook(({ value }) => useStableCallback(() => value), {
			initialProps: { value: 1 },
		});
		const first = result.current;

		rerender({ value: 2 });
		rerender({ value: 3 });

		expect(result.current).toBe(first);
	});

	it("runs the function from the latest render, with its arguments", () => {
		const { result, rerender } = renderHook(
			({ prefix }) => useStableCallback((name: string) => `${prefix} ${name}`),
			{ initialProps: { prefix: "Hello" } }
		);
		const call = result.current;
		expect(call("Ada")).toBe("Hello Ada");

		rerender({ prefix: "Goodbye" });

		// The same function object, now answering from the new render's closure.
		expect(call("Ada")).toBe("Goodbye Ada");
	});
});
