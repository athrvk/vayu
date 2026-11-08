/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNow } from "./useNow";

const START = Date.UTC(2026, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useNow", () => {
	it("re-reads the clock at the instant, and not a tick before", () => {
		const { result } = renderHook(() => useNow(START + 5000));
		expect(result.current).toBe(START);

		act(() => {
			vi.advanceTimersByTime(4999);
		});
		expect(result.current).toBe(START);

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(result.current).toBe(START + 5000);
	});

	it("arms nothing for a null instant", () => {
		renderHook(() => useNow(null));

		expect(vi.getTimerCount()).toBe(0);
	});

	it("arms nothing once the instant has passed, and stops after it fires", () => {
		renderHook(() => useNow(START - 1));
		expect(vi.getTimerCount()).toBe(0);

		const { result } = renderHook(() => useNow(START + 1000));
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(result.current).toBe(START + 1000);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("waits out an instant farther than a timer can count in more than one hop", () => {
		// A delay past 2^31-1 ms fires at once in a browser, which would have the
		// row flip a token that has weeks left.
		const armed = vi.spyOn(globalThis, "setTimeout");
		const instant = START + 40 * DAY_MS;
		const { result } = renderHook(() => useNow(instant));

		act(() => {
			vi.advanceTimersByTime(39 * DAY_MS);
		});
		expect(result.current).toBeLessThan(instant);

		act(() => {
			vi.advanceTimersByTime(DAY_MS);
		});
		expect(result.current).toBe(instant);
		expect(vi.getTimerCount()).toBe(0);
		const delays = armed.mock.calls.map(([, ms]) => ms ?? 0);
		expect(delays.length).toBeGreaterThan(1);
		expect(Math.max(...delays)).toBeLessThanOrEqual(2 ** 31 - 1);
	});

	it("clears its timer on unmount", () => {
		const { unmount } = renderHook(() => useNow(START + 5000));
		expect(vi.getTimerCount()).toBe(1);

		unmount();

		expect(vi.getTimerCount()).toBe(0);
	});

	it("re-arms for a new instant", () => {
		const { result, rerender } = renderHook(({ at }) => useNow(at), {
			initialProps: { at: (START + 1000) as number | null },
		});
		rerender({ at: START + 9000 });

		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(result.current).toBe(START);

		act(() => {
			vi.advanceTimersByTime(8000);
		});
		expect(result.current).toBe(START + 9000);
	});
});
