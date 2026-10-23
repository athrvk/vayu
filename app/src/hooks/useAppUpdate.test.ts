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
import { useUpdateVerificationStore } from "@/stores/update-verification-store";

type AvailableCb = (info: {
	version: string;
	strategy: "silent" | "notify" | "disabled";
	releaseUrl: string;
	installCommand?: string;
}) => void;
type DownloadedCb = (info: { version: string }) => void;
type ProgressCb = (progress: {
	percent: number;
	bytesPerSecond: number;
	transferred: number;
	total: number;
}) => void;

type VerificationFailedCb = (info: { version: string; reason: string }) => void;

let availableCb: AvailableCb | null;
let downloadedCb: DownloadedCb | null;
let progressCb: ProgressCb | null;
let verificationFailedCb: VerificationFailedCb | null;

const FAILURE = {
	version: "1.2.3",
	reason: "GitHub has no attestation for this installer (HTTP 404).",
};

beforeEach(() => {
	availableCb = null;
	downloadedCb = null;
	progressCb = null;
	verificationFailedCb = null;
	useUpdateVerificationStore.setState({ failure: null });
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
		onDownloadProgress: (cb: ProgressCb) => {
			progressCb = cb;
			return () => {
				progressCb = null;
			};
		},
		onUpdateVerificationFailed: (cb: VerificationFailedCb) => {
			verificationFailedCb = cb;
			return () => {
				verificationFailedCb = null;
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

	/**
	 * A download in flight is itself actionable enough to show, not only its
	 * completion (issue #1662) - the silent path's banner has something to
	 * render (a bar) as soon as a percentage exists.
	 */
	test("a silent update in flight shows the banner with its progress", () => {
		const { result } = renderHook(() => useAppUpdate());
		act(() => {
			availableCb?.({ version: "1.2.3", strategy: "silent", releaseUrl: "u" });
		});
		expect(result.current.update).toBeNull();
		expect(result.current.downloadProgress).toBeNull();

		act(() => {
			progressCb?.({ percent: 42, bytesPerSecond: 1, transferred: 1, total: 1 });
		});
		expect(result.current.update?.version).toBe("1.2.3");
		expect(result.current.readyToInstall).toBe(false);
		expect(result.current.downloadProgress).toBeCloseTo(0.42);

		act(() => {
			downloadedCb?.({ version: "1.2.3" });
		});
		// Once ready, the banner switches to the restart button - the bar's job
		// is done, and a stale 100% left behind would fight that button for the
		// same row.
		expect(result.current.downloadProgress).toBeNull();
		expect(result.current.readyToInstall).toBe(true);
	});

	/**
	 * Dismissing the progress bar is "not right now", not "never tell me it's
	 * ready" - the user could not have dismissed a restart prompt that did not
	 * exist yet when they clicked it. Mutation check: drop the
	 * `setDismissed(false)` call in `onUpdateDownloaded` and this reds.
	 */
	test("dismissing mid-download does not swallow the eventual ready-to-install banner", () => {
		const { result } = renderHook(() => useAppUpdate());
		act(() => {
			availableCb?.({ version: "1.2.3", strategy: "silent", releaseUrl: "u" });
		});
		act(() => {
			progressCb?.({ percent: 10, bytesPerSecond: 1, transferred: 1, total: 1 });
		});
		act(() => {
			result.current.dismiss();
		});
		expect(result.current.update).toBeNull();

		act(() => {
			downloadedCb?.({ version: "1.2.3" });
		});
		expect(result.current.update?.version).toBe("1.2.3");
		expect(result.current.readyToInstall).toBe(true);
	});

	describe("a download whose attestation did not verify (issue #2372)", () => {
		const downloadAndFail = (result: { current: ReturnType<typeof useAppUpdate> }) => {
			act(() => {
				availableCb?.({ version: "1.2.3", strategy: "silent", releaseUrl: "u" });
			});
			act(() => {
				progressCb?.({ percent: 100, bytesPerSecond: 1, transferred: 1, total: 1 });
			});
			act(() => {
				verificationFailedCb?.(FAILURE);
			});
			expect(result.current.verificationFailure).toEqual(FAILURE);
		};

		test("clears the progress, is not ready to install, and exposes the failure", () => {
			const { result } = renderHook(() => useAppUpdate());
			downloadAndFail(result);

			expect(result.current.readyToInstall).toBe(false);
			expect(result.current.downloadProgress).toBeNull();
			// Shown, though the silent path otherwise hides what is not actionable.
			expect(result.current.update?.version).toBe("1.2.3");
		});

		test("does not tell the user the update is ready", () => {
			const { result } = renderHook(() => useAppUpdate());
			downloadAndFail(result);
			expect(mockNotifyPost).not.toHaveBeenCalled();
		});

		test("a failure for a newer version removes the restart offered for the earlier one", () => {
			const { result } = renderHook(() => useAppUpdate());
			act(() => {
				availableCb?.({ version: "1.2.3", strategy: "silent", releaseUrl: "u" });
			});
			act(() => {
				downloadedCb?.({ version: "1.2.3" });
			});
			expect(result.current.readyToInstall).toBe(true);

			act(() => {
				verificationFailedCb?.({ version: "1.3.0", reason: "r" });
			});
			expect(result.current.readyToInstall).toBe(false);
			expect(result.current.update?.version).toBe("1.3.0");
			expect(result.current.verificationFailure).toEqual({ version: "1.3.0", reason: "r" });
		});

		test("brings back a banner dismissed during the download", () => {
			const { result } = renderHook(() => useAppUpdate());
			act(() => {
				availableCb?.({ version: "1.2.3", strategy: "silent", releaseUrl: "u" });
			});
			act(() => {
				progressCb?.({ percent: 50, bytesPerSecond: 1, transferred: 1, total: 1 });
			});
			act(() => {
				result.current.dismiss();
			});
			act(() => {
				verificationFailedCb?.(FAILURE);
			});
			expect(result.current.update?.version).toBe("1.2.3");
		});

		test("a later verified download clears it", () => {
			const { result } = renderHook(() => useAppUpdate());
			downloadAndFail(result);

			act(() => {
				downloadedCb?.({ version: "1.2.3" });
			});
			expect(result.current.verificationFailure).toBeNull();
			expect(result.current.readyToInstall).toBe(true);
		});

		test("a later announcement clears it", () => {
			const { result } = renderHook(() => useAppUpdate());
			downloadAndFail(result);

			act(() => {
				availableCb?.({ version: "1.3.0", strategy: "silent", releaseUrl: "u" });
			});
			expect(result.current.verificationFailure).toBeNull();
			expect(result.current.update).toBeNull();
		});

		test("is kept for a reader that mounts after the event", () => {
			const { result } = renderHook(() => useAppUpdate());
			downloadAndFail(result);

			// Settings > Updates opens long after the event arrived.
			expect(useUpdateVerificationStore.getState().failure).toEqual(FAILURE);
		});

		test("unsubscribes on unmount", () => {
			const { unmount } = renderHook(() => useAppUpdate());
			expect(verificationFailedCb).not.toBeNull();
			unmount();
			expect(verificationFailedCb).toBeNull();
		});
	});
});
