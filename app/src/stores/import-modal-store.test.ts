/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one-shot pending path an OS open-intent hands the import dialog (#1364).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useImportModalStore } from "./import-modal-store";

beforeEach(() => {
	useImportModalStore.setState({ isOpen: false, pendingPath: null });
});

describe("useImportModalStore - pending path", () => {
	it("opens with a path waiting", () => {
		useImportModalStore.getState().openWithFile("/tmp/spec.json");

		const state = useImportModalStore.getState();
		expect(state.isOpen).toBe(true);
		expect(state.pendingPath).toBe("/tmp/spec.json");
	});

	/*
	 * Mutation check: have `takePendingPath` read `pendingPath` without the
	 * `set({ pendingPath: null })` call, and the second read below returns the
	 * same path instead of null - which is what would let a re-render import
	 * the same file twice.
	 */
	it("clears the path on read, so a second read finds nothing", () => {
		useImportModalStore.getState().openWithFile("/tmp/spec.json");

		expect(useImportModalStore.getState().takePendingPath()).toBe("/tmp/spec.json");
		expect(useImportModalStore.getState().takePendingPath()).toBeNull();
	});

	it("returns null when nothing is pending", () => {
		expect(useImportModalStore.getState().takePendingPath()).toBeNull();
	});

	/*
	 * Mutation check: drop `pendingPath: null` from `close()` and a path
	 * dismissed unread is still there the next time the dialog opens.
	 */
	it("close drops a path that was never read", () => {
		useImportModalStore.getState().openWithFile("/tmp/spec.json");

		useImportModalStore.getState().close();

		expect(useImportModalStore.getState().pendingPath).toBeNull();
	});
});
