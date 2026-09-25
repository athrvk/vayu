/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDataFileStore } from "@/stores/data-file-store";
import { useDataFileLocationMirror } from "./useDataFileLocationMirror";

const USERS = { path: "/data/users.csv", fileName: "users.csv" };

describe("useDataFileLocationMirror", () => {
	let publish: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		useDataFileStore.setState({ locations: { col_1: USERS } });
		publish = vi.fn();
		vi.stubGlobal("electronAPI", { publishDataFileLocations: publish });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("publishes the whole map on mount, then on every change", () => {
		const view = renderHook(() => useDataFileLocationMirror());
		expect(publish).toHaveBeenLastCalledWith({ col_1: USERS });

		act(() => useDataFileStore.getState().clearDataFile("col_1"));
		// Mutation check: drop the subscription and main keeps a path the user cleared.
		expect(publish).toHaveBeenLastCalledWith({});
		expect(publish).toHaveBeenCalledTimes(2);

		view.unmount();
		act(() => useDataFileStore.getState().setDataFile("col_2", USERS));
		expect(publish).toHaveBeenCalledTimes(2);
	});

	it("does nothing outside Electron", () => {
		vi.stubGlobal("electronAPI", undefined);
		expect(() => renderHook(() => useDataFileLocationMirror())).not.toThrow();
		expect(publish).not.toHaveBeenCalled();
	});
});
