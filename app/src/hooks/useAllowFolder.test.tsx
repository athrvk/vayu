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
 * What the hook hands the preload bridge when a surface asks to allow a folder
 * (#2378): the dialog's key and nothing else. The title and where the picker
 * opens are the main process's, so a surface has no argument to put them in.
 *
 * The real mutation and `apiService` run; only the bridge is a stub, so the
 * assertion is on the arguments the preload would receive.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useToastStore } from "@/stores";
import { useAllowFolder } from "./useAllowFolder";

const allowFolder = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("electronAPI", { allowFolder });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useAllowFolder", () => {
	it("passes the dialog key and no path, title or options", async () => {
		allowFolder.mockResolvedValue({
			outcome: "done",
			path: "/data",
			value: { id: "r1", path: "/data", createdAt: 1 },
		});
		const { result } = renderHook(() => useAllowFolder(), { wrapper });

		let allowed: boolean | undefined;
		await act(async () => {
			allowed = await result.current.chooseAndAllow?.();
		});

		expect(allowed).toBe(true);
		expect(allowFolder.mock.calls).toEqual([["allow-folder"]]);
	});

	it("reports false for a cancelled dialog", async () => {
		allowFolder.mockResolvedValue({ outcome: "cancelled" });
		const { result } = renderHook(() => useAllowFolder(), { wrapper });

		let allowed: boolean | undefined;
		await act(async () => {
			allowed = await result.current.chooseAndAllow?.();
		});

		expect(allowed).toBe(false);
	});

	it("says the picker could not open when the bridge itself rejects", async () => {
		allowFolder.mockRejectedValue(new Error("Unknown folder dialog: allow-folder"));
		const showToast = vi.spyOn(useToastStore.getState(), "showToast");
		const { result } = renderHook(() => useAllowFolder(), { wrapper });

		let allowed: boolean | undefined;
		await act(async () => {
			allowed = await result.current.chooseAndAllow?.();
		});

		expect(allowed).toBe(false);
		expect(showToast).toHaveBeenCalledWith(
			"Couldn't open the folder picker. Restart Vayu.",
			"error"
		);
	});

	it("offers nothing where there is no bridge", () => {
		vi.stubGlobal("electronAPI", undefined);
		const { result } = renderHook(() => useAllowFolder(), { wrapper });

		expect(result.current.chooseAndAllow).toBeUndefined();
	});
});
