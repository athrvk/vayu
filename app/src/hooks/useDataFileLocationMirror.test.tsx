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

import { mirrorFileBindings } from "@/queries/file-bindings";
import { useDataFileStore } from "@/stores/data-file-store";
import type { Collection, DataFileLocation } from "@/types";
import { useDataFileLocationMirror } from "./useDataFileLocationMirror";

const USERS = { path: "/data/users.csv", fileName: "users.csv" };

/** The collections list as the store's feeder sees it: one row per binding. */
function listWith(bindings: Record<string, DataFileLocation>): Collection[] {
	return Object.entries(bindings).map(
		([id, dataFile]) => ({ id, name: id, order: 0, dataFile }) as unknown as Collection
	);
}

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

		act(() => mirrorFileBindings(listWith({})));
		// Mutation check: drop the subscription and main keeps a path the user cleared.
		expect(publish).toHaveBeenLastCalledWith({});
		expect(publish).toHaveBeenCalledTimes(2);

		view.unmount();
		act(() => mirrorFileBindings(listWith({ col_2: USERS })));
		expect(publish).toHaveBeenCalledTimes(2);
	});

	it("republishes when the engine row records a new hash, carrying it to main (#2051)", () => {
		renderHook(() => useDataFileLocationMirror());
		const hash = "9".repeat(64);

		act(() => mirrorFileBindings(listWith({ col_1: { ...USERS, hash } })));

		expect(publish).toHaveBeenLastCalledWith({ col_1: { ...USERS, hash } });
		expect(publish).toHaveBeenCalledTimes(2);
		// A refetch answering the same binding changes nothing, so nothing is sent.
		act(() => mirrorFileBindings(listWith({ col_1: { ...USERS, hash } })));
		expect(publish).toHaveBeenCalledTimes(2);
	});

	it("does nothing outside Electron, on mount or on a change", () => {
		vi.stubGlobal("electronAPI", undefined);
		// Mutation check: drop the `if (!publish) return` guard and the mount
		// calls an undefined publisher; subscribe before it and the change does.
		expect(() => renderHook(() => useDataFileLocationMirror())).not.toThrow();
		expect(() => act(() => mirrorFileBindings(listWith({ col_2: USERS })))).not.toThrow();
	});
});
