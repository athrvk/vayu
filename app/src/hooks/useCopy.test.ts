/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A copy that failed must never look like one that worked (#555, #565, #1686).
 *
 * The defect this guards is not theoretical: six call sites awaited
 * `writeText` with no catch, so a denied clipboard threw, the state that draws
 * the check never ran, and the user's only evidence was pasting the *previous*
 * clipboard contents somewhere else. Mutation check: delete the `catch` block
 * in `useCopy.ts` and "reports the failure ..." fails on the unhandled
 * rejection, while "leaves `copied` false ..." fails on the throw.
 *
 * Real timers, not fake ones: the assertions here are about which branch ran,
 * and the reset is covered by the branch that schedules it rather than by
 * waiting out `COPY_RESET_MS`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { TIMING } from "@/config/timing";
import { useToastStore } from "@/stores";
import { useCopy } from "./useCopy";

const writeText = vi.fn<(value: string) => Promise<void>>();

beforeEach(() => {
	writeText.mockReset();
	writeText.mockResolvedValue(undefined);
	// jsdom ships no clipboard at all, so this is a definition rather than a
	// replacement - `vi.stubGlobal` on `navigator` would drop the rest of it.
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
	useToastStore.setState({ toasts: [] });
});

function toastTexts() {
	return useToastStore.getState().toasts.map((t) => `${t.variant}:${t.message}`);
}

describe("useCopy", () => {
	it("writes the value and toasts by default", async () => {
		const { result } = renderHook(() => useCopy());
		await act(() => result.current.copy("https://localhost:1234", "Inbox URL"));
		expect(writeText).toHaveBeenCalledWith("https://localhost:1234");
		expect(toastTexts()).toEqual(["success:Inbox URL copied"]);
		// The toast idiom and the icon idiom are exclusive: a text button that
		// toasts must not also be told it can draw a check.
		expect(result.current.copied).toBe(false);
	});

	it("flips `copied` instead of toasting in icon mode", async () => {
		const { result } = renderHook(() => useCopy({ feedback: "icon" }));
		await act(() => result.current.copy("curl -X GET", "Snippet"));
		expect(result.current.copied).toBe(true);
		expect(toastTexts()).toEqual([]);
	});

	it("resets `copied` after COPY_RESET_MS, with no call site scheduling it", async () => {
		vi.useFakeTimers();
		try {
			const { result } = renderHook(() => useCopy({ feedback: "icon" }));
			await act(() => result.current.copy("x", "Value"));
			expect(result.current.copied).toBe(true);
			act(() => {
				vi.advanceTimersByTime(TIMING.COPY_RESET_MS - 1);
			});
			expect(result.current.copied).toBe(true);
			act(() => {
				vi.advanceTimersByTime(1);
			});
			expect(result.current.copied).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("gives a second copy inside the window the full duration, not the tail of the first", async () => {
		vi.useFakeTimers();
		try {
			const { result } = renderHook(() => useCopy({ feedback: "icon" }));
			await act(() => result.current.copy("x", "Value"));
			act(() => {
				vi.advanceTimersByTime(TIMING.COPY_RESET_MS - 100);
			});
			await act(() => result.current.copy("y", "Value"));
			act(() => {
				vi.advanceTimersByTime(TIMING.COPY_RESET_MS - 1);
			});
			expect(result.current.copied).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports the failure when the clipboard rejects", async () => {
		writeText.mockRejectedValue(new Error("Write permission denied"));
		const { result } = renderHook(() => useCopy());
		await act(() => result.current.copy("x", "Inbox URL"));
		expect(toastTexts()).toEqual(["error:Could not copy: Write permission denied"]);
	});

	it("leaves `copied` false and still reports the failure in icon mode", async () => {
		writeText.mockRejectedValue(new Error("Document is not focused"));
		const { result } = renderHook(() => useCopy({ feedback: "icon" }));
		await act(() => result.current.copy("x", "Snippet"));
		// The whole point: no check appears, and the reason is on screen anyway.
		// An icon button has no failure glyph, so the failure toasts in both modes.
		expect(result.current.copied).toBe(false);
		expect(toastTexts()).toEqual(["error:Could not copy: Document is not focused"]);
	});

	it("reports a rejection that is not an Error", async () => {
		writeText.mockRejectedValue("nope");
		const { result } = renderHook(() => useCopy());
		await act(() => result.current.copy("x", "Snippet"));
		await waitFor(() => expect(toastTexts()).toEqual(["error:Could not copy"]));
	});
});
