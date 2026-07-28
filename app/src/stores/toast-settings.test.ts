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
 * The three notification preferences applied at enqueue.
 *
 * Position is the only one the Toaster sees; the duration scale, the stack cap
 * and the severity floor are all resolved when `showToast` is called, so this
 * is where they have to be checked. Store-level rather than rendered, because
 * none of them produce a visible difference in jsdom - a dropped toast and a
 * queued one look identical without layout.
 *
 * jsdom is needed despite nothing rendering: `client-settings-store` persists
 * through zustand's `persist`, which reaches for `localStorage` on import.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { useToastStore } from "./toast-store";
import { useClientSettingsStore } from "./client-settings-store";
import { TIMING } from "@/config/timing";
import {
	DEFAULT_NOTIFICATION_PREFS,
	NEVER_DISMISS_MS,
	type NotificationPrefs,
} from "@/constants/toast";

function setPrefs(patch: Partial<NotificationPrefs>) {
	useClientSettingsStore.setState({
		notifications: { ...DEFAULT_NOTIFICATION_PREFS, ...patch },
	});
}

beforeEach(() => {
	useToastStore.setState({ toasts: [] });
	setPrefs({});
});

describe("duration scale", () => {
	it("multiplies the variant's tuned duration rather than replacing it", () => {
		setPrefs({ durationScale: "short" });
		useToastStore.getState().showToast({ message: "a", variant: "error" });
		useToastStore.getState().showToast({ message: "b", variant: "success" });

		const [error, success] = useToastStore.getState().toasts;
		expect(error.duration).toBe(TIMING.TOAST_DURATION_MS.error * 0.5);
		expect(success.duration).toBe(TIMING.TOAST_DURATION_MS.success * 0.5);
		// The whole point of scaling: a failure still outlasts a confirmation.
		expect(error.duration).toBeGreaterThan(success.duration);
	});

	it("doubles on long and leaves default alone", () => {
		setPrefs({ durationScale: "long" });
		useToastStore.getState().showToast({ message: "a", variant: "info" });
		expect(useToastStore.getState().toasts[0].duration).toBe(TIMING.TOAST_DURATION_MS.info * 2);

		useToastStore.setState({ toasts: [] });
		setPrefs({ durationScale: "default" });
		useToastStore.getState().showToast({ message: "b", variant: "info" });
		expect(useToastStore.getState().toasts[0].duration).toBe(TIMING.TOAST_DURATION_MS.info);
	});

	it("uses a finite sentinel for never, not Infinity", () => {
		setPrefs({ durationScale: "never" });
		useToastStore.getState().showToast({ message: "a", variant: "warning" });

		const { duration } = useToastStore.getState().toasts[0];
		// The primitive arms a real setTimeout; a non-finite delay is coerced to 1
		// there, which would dismiss instantly - the opposite of "never".
		expect(Number.isFinite(duration)).toBe(true);
		expect(duration).toBe(NEVER_DISMISS_MS);
	});

	it("lets an explicit duration win over the scale", () => {
		setPrefs({ durationScale: "short" });
		useToastStore.getState().showToast({ message: "a", variant: "error", duration: 1234 });
		expect(useToastStore.getState().toasts[0].duration).toBe(1234);
	});
});

describe("severity floor", () => {
	it("drops everything below the floor and keeps everything at or above", () => {
		setPrefs({ minSeverity: "warning" });
		const show = useToastStore.getState().showToast;
		show({ message: "i", variant: "info" });
		show({ message: "s", variant: "success" });
		show({ message: "w", variant: "warning" });
		show({ message: "e", variant: "error" });

		expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["w", "e"]);
	});

	it("keeps only errors at the errors-only floor", () => {
		setPrefs({ minSeverity: "error" });
		const show = useToastStore.getState().showToast;
		show({ message: "w", variant: "warning" });
		show({ message: "e", variant: "error" });
		expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["e"]);
	});

	it("silences everything at none, errors included", () => {
		setPrefs({ minSeverity: "none" });
		useToastStore.getState().showToast({ message: "e", variant: "error" });
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("still returns a dismissable id for a dropped toast", () => {
		setPrefs({ minSeverity: "none" });
		const id = useToastStore.getState().showToast({ message: "e", variant: "error" });
		expect(id).toBeTruthy();
		// Callers hold the id to dismiss early. Muting must not turn that into a
		// crash at a call site that has no idea the toast was dropped.
		expect(() => useToastStore.getState().dismissToast(id)).not.toThrow();
	});
});

describe("stack cap", () => {
	it("keeps the newest N and drops the oldest", () => {
		setPrefs({ maxVisible: 2 });
		const show = useToastStore.getState().showToast;
		show({ message: "one" });
		show({ message: "two" });
		show({ message: "three" });

		expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["two", "three"]);
	});

	it("honours a raised cap", () => {
		setPrefs({ maxVisible: 6 });
		const show = useToastStore.getState().showToast;
		for (let i = 0; i < 6; i++) show({ message: `m${i}` });
		expect(useToastStore.getState().toasts).toHaveLength(6);
	});
});
