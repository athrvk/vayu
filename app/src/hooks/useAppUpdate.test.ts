/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useAppUpdate } from "./useAppUpdate";

type AvailableCb = (info: {
	version: string;
	strategy: "silent" | "notify" | "disabled";
	releaseUrl: string;
	installCommand?: string;
}) => void;
type DownloadedCb = (info: { version: string }) => void;

let availableCb: AvailableCb | null;
let downloadedCb: DownloadedCb | null;

beforeEach(() => {
	availableCb = null;
	downloadedCb = null;
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		onUpdateAvailable: (cb: AvailableCb) => {
			availableCb = cb;
			return () => {
				availableCb = null;
			};
		},
		onUpdateDownloaded: (cb: DownloadedCb) => {
			downloadedCb = cb;
			return () => {
				downloadedCb = null;
			};
		},
		restartToInstallUpdate: vi.fn(),
		openReleasePage: vi.fn(),
	};
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("useAppUpdate", () => {
	test("surfaces a notify update immediately", () => {
		const { result } = renderHook(() => useAppUpdate());
		act(() => {
			availableCb?.({ version: "1.2.3", strategy: "notify", releaseUrl: "u" });
		});
		expect(result.current.update?.version).toBe("1.2.3");
	});

	test("hides a silent update until it has downloaded", () => {
		const { result } = renderHook(() => useAppUpdate());
		act(() => {
			availableCb?.({ version: "1.2.3", strategy: "silent", releaseUrl: "u" });
		});
		// Still downloading in the background — nothing to show yet.
		expect(result.current.update).toBeNull();

		act(() => {
			downloadedCb?.({ version: "1.2.3" });
		});
		expect(result.current.update?.version).toBe("1.2.3");
		expect(result.current.readyToInstall).toBe(true);
	});

	test("dismiss hides the banner", () => {
		const { result } = renderHook(() => useAppUpdate());
		act(() => {
			availableCb?.({ version: "1.2.3", strategy: "notify", releaseUrl: "u" });
		});
		act(() => {
			result.current.dismiss();
		});
		expect(result.current.update).toBeNull();
	});
});
