/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

type Listener = (e: MediaQueryListEvent) => void;

/** Installs a controllable `matchMedia`, returning a way to flip it. */
function stubMatchMedia(initial: boolean) {
	const listeners = new Set<Listener>();
	let matches = initial;
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches,
		media: query,
		addEventListener: (_: string, fn: Listener) => listeners.add(fn),
		removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
	}));
	return (next: boolean) => {
		matches = next;
		for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("usePrefersReducedMotion", () => {
	it("reports the system preference", () => {
		stubMatchMedia(true);
		const { result } = renderHook(() => usePrefersReducedMotion());
		expect(result.current).toBe(true);
	});

	it("reports false when the system asks for nothing", () => {
		stubMatchMedia(false);
		const { result } = renderHook(() => usePrefersReducedMotion());
		expect(result.current).toBe(false);
	});

	it("follows the preference changing while the app is open", () => {
		// The moment that matters: a user turns Reduce Motion on in the OS to see
		// what happens, and the settings row must stop saying otherwise.
		const flip = stubMatchMedia(false);
		const { result } = renderHook(() => usePrefersReducedMotion());
		expect(result.current).toBe(false);
		act(() => flip(true));
		expect(result.current).toBe(true);
	});

	it("does not throw where matchMedia is unavailable", () => {
		vi.stubGlobal("matchMedia", undefined);
		const { result } = renderHook(() => usePrefersReducedMotion());
		expect(result.current).toBe(false);
	});
});
