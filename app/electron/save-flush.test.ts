/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a flush reports and what the app says when it did not land (#1489).
 * The flush's round trip and the state both gestures share are
 * `quit-flow.ts`'s, and are tested in `quit-flow.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { buildFlushFailurePrompt, flushNeedsConfirmation, parseFlushResult } from "./save-flush";

describe("asking before a failed flush is discarded (#1489)", () => {
	it("needs no confirmation for a clean settle", () => {
		expect(flushNeedsConfirmation({ saved: 3, failed: 0, pending: 0 })).toBe(false);
	});

	it("needs confirmation for a failure, a still-pending edit, or an unanswered ceiling", () => {
		expect(flushNeedsConfirmation({ saved: 0, failed: 1, pending: 0 })).toBe(true);
		expect(flushNeedsConfirmation({ saved: 1, failed: 0, pending: 1 })).toBe(true);
		expect(flushNeedsConfirmation(null)).toBe(true);
	});

	it("names the count and phrases the buttons for the gesture", () => {
		const quitPrompt = buildFlushFailurePrompt("quit", { saved: 0, failed: 2, pending: 0 });
		expect(quitPrompt.message).toContain("2 edits");
		expect(quitPrompt.buttons).toEqual(["Quit anyway", "Keep working"]);

		const closePrompt = buildFlushFailurePrompt("window-close", {
			saved: 0,
			failed: 1,
			pending: 0,
		});
		expect(closePrompt.message).toContain("one edit");
		expect(closePrompt.buttons).toEqual(["Close anyway", "Keep working"]);
	});

	it("blames the engine for a failed save and for an unanswered ceiling", () => {
		for (const result of [{ saved: 0, failed: 1, pending: 0 }, null]) {
			const prompt = buildFlushFailurePrompt("quit", result);
			expect(prompt.message).toContain("Vayu's engine isn't responding");
			expect(prompt.detail).toContain("once Vayu's engine answers");
		}
	});

	it("says the disk is full, not that the engine is down, when the failure was a full disk", () => {
		const prompt = buildFlushFailurePrompt("quit", {
			saved: 0,
			failed: 2,
			pending: 0,
			reason: "disk-full",
		});
		expect(prompt.message).toBe("Couldn't save 2 edits - the disk is full.");
		expect(prompt.detail).toBe(
			"Quitting anyway discards them. Free up space, then keep working to save again."
		);
		expect(prompt.message).not.toContain("engine");
		expect(prompt.detail).not.toContain("engine");
		expect(prompt.buttons).toEqual(["Quit anyway", "Keep working"]);
	});

	it("counts a pending edit beside a disk-full failure in the subject", () => {
		const prompt = buildFlushFailurePrompt("window-close", {
			saved: 0,
			failed: 1,
			pending: 1,
			reason: "disk-full",
		});
		expect(prompt.message).toBe("Couldn't save 2 edits - the disk is full.");
	});

	it("ignores a reason on a result with no failure", () => {
		const prompt = buildFlushFailurePrompt("quit", {
			saved: 0,
			failed: 0,
			pending: 1,
			reason: "disk-full",
		});
		expect(prompt.message).toBe("One edit couldn't be saved as it is.");
		expect(prompt.detail).not.toContain("Free up space");
	});

	it("keeps the engine wording for a failure with no reason", () => {
		const prompt = buildFlushFailurePrompt("quit", { saved: 0, failed: 1, pending: 0 });
		expect(prompt.message).toBe("Couldn't save one edit - Vayu's engine isn't responding.");
		expect(prompt.message).not.toContain("disk");
	});

	it("does not blame the engine for an edit that was only blocked", () => {
		const prompt = buildFlushFailurePrompt("quit", { saved: 0, failed: 0, pending: 1 });
		expect(prompt.message).toBe("One edit couldn't be saved as it is.");
		expect(prompt.detail).not.toContain("engine");

		const plural = buildFlushFailurePrompt("window-close", { saved: 0, failed: 0, pending: 3 });
		expect(plural.message).toBe("3 edits couldn't be saved as they are.");
		expect(plural.detail).toContain("Closing anyway discards them.");
		expect(plural.detail).not.toContain("engine");
	});

	it("blames the engine when a failure sits beside a blocked edit", () => {
		const prompt = buildFlushFailurePrompt("quit", { saved: 0, failed: 1, pending: 1 });
		expect(prompt.message).toContain("2 edits");
		expect(prompt.message).toContain("Vayu's engine isn't responding");
	});
});

describe("parseFlushResult", () => {
	it("reads a report, keeping a disk-full reason and nothing else", () => {
		expect(parseFlushResult({ saved: 2, failed: 1, pending: 0 })).toEqual({
			saved: 2,
			failed: 1,
			pending: 0,
		});
		expect(parseFlushResult({ saved: 0, failed: 1, pending: 0, reason: "disk-full" })).toEqual({
			saved: 0,
			failed: 1,
			pending: 0,
			reason: "disk-full",
		});
		expect(parseFlushResult({ saved: 0, failed: 1, pending: 0, reason: "gremlins" })).toEqual({
			saved: 0,
			failed: 1,
			pending: 0,
		});
	});

	it("refuses anything that is not a report, so it is asked about rather than trusted", () => {
		expect(parseFlushResult(undefined)).toBeNull();
		expect(parseFlushResult(null)).toBeNull();
		expect(parseFlushResult({ saved: 1, failed: 0 })).toBeNull();
		expect(parseFlushResult({ saved: 1, failed: -1, pending: 0 })).toBeNull();
		expect(parseFlushResult({ saved: 1.5, failed: 0, pending: 0 })).toBeNull();
		expect(parseFlushResult({ saved: "1", failed: 0, pending: 0 })).toBeNull();
	});
});
