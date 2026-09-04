/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// An update becoming installable is one of the events that may land while the
// user is in another application (#1358).
const { mockNotifyPost } = vi.hoisted(() => ({ mockNotifyPost: vi.fn() }));
vi.mock("@/services/notify", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/services/notify")>()),
	systemNotify: { post: mockNotifyPost, availability: vi.fn() },
}));

import { useAppUpdate } from "./useAppUpdate";
import { NOTIFY_KINDS } from "@/services/notify";

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
	mockNotifyPost.mockClear();
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
		// Still downloading in the background - nothing to show yet.
		expect(result.current.update).toBeNull();

		act(() => {
			downloadedCb?.({ version: "1.2.3" });
		});
		expect(result.current.update?.version).toBe("1.2.3");
		expect(result.current.readyToInstall).toBe(true);
	});

	test("a newly announced version is not installable until it has downloaded", () => {
		// The silent path's nastiest edge: v1 is downloaded and the banner offers
		// "restart to install", then the 6h check announces v2. The banner's
		// version updates, so leaving readyToInstall true offers to install a
		// version that is still downloading - and what quitAndInstall then finds
		// staged is v1 on Windows, or on AppImage a file electron-updater has
		// already deleted, taking the running AppImage with it.
		const { result } = renderHook(() => useAppUpdate());
		act(() => {
			availableCb?.({ version: "1.2.3", strategy: "silent", releaseUrl: "u" });
		});
		act(() => {
			downloadedCb?.({ version: "1.2.3" });
		});
		expect(result.current.readyToInstall).toBe(true);

		act(() => {
			availableCb?.({ version: "1.3.0", strategy: "silent", releaseUrl: "u" });
		});
		expect(result.current.readyToInstall).toBe(false);
		// Nothing actionable to show while it downloads, either.
		expect(result.current.update).toBeNull();

		act(() => {
			downloadedCb?.({ version: "1.3.0" });
		});
		expect(result.current.readyToInstall).toBe(true);
		expect(result.current.update?.version).toBe("1.3.0");
	});

	test("tells the user once the update is theirs to install", () => {
		renderHook(() => useAppUpdate());

		// The silent path: the announcement is not actionable, the download is.
		act(() => {
			availableCb?.({ version: "1.2.3", strategy: "silent", releaseUrl: "u" });
		});
		expect(mockNotifyPost).not.toHaveBeenCalled();

		act(() => {
			downloadedCb?.({ version: "1.2.3" });
		});
		expect(mockNotifyPost).toHaveBeenCalledWith({
			kind: NOTIFY_KINDS.updateReady,
			title: "Vayu 1.2.3 is ready",
			body: "Restart Vayu to update.",
			target: { view: "settings" },
		});
	});

	test("tells the user about a notify-path update, where the announcement is all there is", () => {
		renderHook(() => useAppUpdate());

		// macOS: nothing downloads on its own, so this announcement is the whole
		// story. Drop the `strategy === "notify"` guard and the silent path above
		// starts notifying twice for one version.
		act(() => {
			availableCb?.({ version: "1.2.3", strategy: "notify", releaseUrl: "u" });
		});

		expect(mockNotifyPost).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: NOTIFY_KINDS.updateReady,
				title: "Vayu 1.2.3 is available",
			})
		);
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
