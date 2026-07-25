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
 * A save failure should say why. Same requirement as before, different surface.
 *
 * `save-store` used to record an `errorMessage` that nothing read, so the status
 * strip showed a bare "Save failed" for every cause. That was fixed by rendering
 * the reason in the Dock. Failures are now reported by a toast instead - one
 * channel for every failure in the app, and room for an engine message like
 * "database is locked" without truncating it into a `title` attribute.
 *
 * The requirement outlived the mechanism, so this file did too. What it guards
 * now is the seam: `failSave` is what eight call sites reach, and it is the only
 * thing that turns them into a toast. If that link breaks, every one of those
 * failures goes unreported - which is exactly the state the original fix
 * existed to end.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { useSaveStore, useToastStore } from "@/stores";

const dock = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Dock.tsx"), "utf8");
const code = dock.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

beforeEach(() => {
	useSaveStore.setState({ status: "idle" });
	useToastStore.setState({ toasts: [] });
});

describe("save failure reporting", () => {
	it("turns a failure into a toast carrying the reason", () => {
		useSaveStore.getState().failSave("database is locked");
		const [toast] = useToastStore.getState().toasts;
		expect(toast?.message).toBe("database is locked");
		expect(toast?.variant).toBe("error");
	});

	it("still records the status, which the Dock reads", () => {
		useSaveStore.getState().failSave("disk full");
		expect(useSaveStore.getState().status).toBe("error");
	});

	it("does not truncate an engine message the way the strip had to", () => {
		// The old surface was a 60-character span with the remainder hidden in a
		// `title`. The reason a toast is the better home for this text.
		const long = "database is locked: attempt 3 of 3 failed after 5000ms, giving up";
		useSaveStore.getState().failSave(long);
		expect(useToastStore.getState().toasts[0]?.message).toBe(long);
	});

	it("no longer renders a competing error line in the Dock", () => {
		// Two surfaces for one failure was the thing being removed; if a Dock
		// error line comes back, the unification has quietly been undone.
		expect(code).not.toMatch(/saveError/);
		expect(code).not.toMatch(/Save failed/);
	});

	it("keeps the Dock reporting the states that are not failures", () => {
		expect(code).toMatch(/saveStatus === "saving"/);
		expect(code).toMatch(/saveStatus === "saved"/);
	});
});
