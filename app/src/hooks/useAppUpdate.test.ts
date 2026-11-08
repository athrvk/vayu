/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
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
import type { UpdateDownloadState } from "@/types/electron";

type AvailableCb = (info: {
	version: string;
	strategy: "silent" | "notify" | "disabled";
	releaseUrl: string;
	installCommand?: string;
}) => void;
type StateCb = (state: UpdateDownloadState) => void;

let availableCb: AvailableCb | null;
let stateCb: StateCb | null;
/** What `getUpdateState()` answers; a test sets it before it renders. */
let snapshot: Promise<UpdateDownloadState>;

const FAILURE = {
	version: "1.2.3",
	reason: "GitHub has no attestation for this installer (HTTP 404).",
};

const progress = (percent: number): UpdateDownloadState => ({
	kind: "downloading",
	version: "1.2.3",
	progress: { percent, bytesPerSecond: 1, transferred: 1, total: 1 },
});
const downloading = (version = "1.2.3"): UpdateDownloadState => ({
	kind: "downloading",
	version,
	progress: null,
});
const verified = (version = "1.2.3"): UpdateDownloadState => ({ kind: "verified", version });
const refused = (version = FAILURE.version, reason = FAILURE.reason): UpdateDownloadState => ({
	kind: "refused",
	version,
	reason,
});
const failed = (version = "1.2.3"): UpdateDownloadState => ({
	kind: "failed",
	version,
	error: "net::ERR_INTERNET_DISCONNECTED",
});

const announce = (version = "1.2.3") =>
	act(() => {
		availableCb?.({ version, strategy: "silent", releaseUrl: "u" });
	});
const push = (state: UpdateDownloadState) =>
	act(() => {
		stateCb?.(state);
	});

beforeEach(() => {
	availableCb = null;
	stateCb = null;
	snapshot = Promise.resolve({ kind: "none" });
	useUpdateVerificationStore.setState({ failure: null });
	mockNotifyPost.mockClear();
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		onUpdateAvailable: (cb: AvailableCb) => {
			availableCb = cb;
			return () => {
				availableCb = null;
			};
		},
		onUpdateState: (cb: StateCb) => {
			stateCb = cb;
			return () => {
				stateCb = null;
			};
		},
		getUpdateState: () => snapshot,
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
		announce();
		push(downloading());
		// Still downloading in the background - nothing to show yet.
		expect(result.current.update).toBeNull();

		push(verified());
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
		announce();
		push(verified());
		expect(result.current.readyToInstall).toBe(true);

		announce("1.3.0");
		push(downloading("1.3.0"));
		expect(result.current.readyToInstall).toBe(false);
		// Nothing actionable to show while it downloads, either.
		expect(result.current.update).toBeNull();

		push(verified("1.3.0"));
		expect(result.current.readyToInstall).toBe(true);
		expect(result.current.update?.version).toBe("1.3.0");
	});

	test("tells the user once the update is theirs to install", () => {
		renderHook(() => useAppUpdate());

		// The silent path: the announcement is not actionable, the download is.
		announce();
		push(downloading());
		expect(mockNotifyPost).not.toHaveBeenCalled();

		push(verified());
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
		announce();
		push(downloading());
		expect(result.current.update).toBeNull();
		expect(result.current.downloadProgress).toBeNull();

		push(progress(42));
		expect(result.current.update?.version).toBe("1.2.3");
		expect(result.current.readyToInstall).toBe(false);
		expect(result.current.downloadProgress).toBeCloseTo(0.42);

		push(verified());
		// Once ready, the banner switches to the restart button - the bar's job
		// is done, and a stale 100% left behind would fight that button for the
		// same row.
		expect(result.current.downloadProgress).toBeNull();
		expect(result.current.readyToInstall).toBe(true);
	});

	test("reads the wait for the attestation check as a full bar", () => {
		const { result } = renderHook(() => useAppUpdate());
		announce();
		push({ kind: "verifying", version: "1.2.3" });
		expect(result.current.downloadProgress).toBe(1);
		expect(result.current.readyToInstall).toBe(false);
		expect(result.current.update?.version).toBe("1.2.3");
	});

	/**
	 * Dismissing the progress bar is "not right now", not "never tell me it's
	 * ready" - the user could not have dismissed a restart prompt that did not
	 * exist yet when they clicked it. Mutation check: drop the
	 * `setDismissed(false)` call in `apply` and this reds.
	 */
	test("dismissing mid-download does not swallow the eventual ready-to-install banner", () => {
		const { result } = renderHook(() => useAppUpdate());
		announce();
		push(progress(10));
		act(() => {
			result.current.dismiss();
		});
		expect(result.current.update).toBeNull();

		push(verified());
		expect(result.current.update?.version).toBe("1.2.3");
		expect(result.current.readyToInstall).toBe(true);
	});

	describe("a download whose attestation did not verify (issue #2372)", () => {
		const downloadAndFail = (result: { current: ReturnType<typeof useAppUpdate> }) => {
			announce();
			push(progress(100));
			push({ kind: "verifying", version: "1.2.3" });
			push(refused());
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
			announce();
			push(verified());
			expect(result.current.readyToInstall).toBe(true);

			push(refused("1.3.0", "r"));
			expect(result.current.readyToInstall).toBe(false);
			expect(result.current.update?.version).toBe("1.3.0");
			expect(result.current.verificationFailure).toEqual({ version: "1.3.0", reason: "r" });
		});

		test("brings back a banner dismissed during the download", () => {
			const { result } = renderHook(() => useAppUpdate());
			announce();
			push(progress(50));
			act(() => {
				result.current.dismiss();
			});
			push(refused());
			expect(result.current.update?.version).toBe("1.2.3");
		});

		test("a later verified download clears it", () => {
			const { result } = renderHook(() => useAppUpdate());
			downloadAndFail(result);

			push(verified());
			expect(result.current.verificationFailure).toBeNull();
			expect(result.current.readyToInstall).toBe(true);
		});

		test("a later announcement clears it", () => {
			const { result } = renderHook(() => useAppUpdate());
			downloadAndFail(result);

			announce("1.3.0");
			push(downloading("1.3.0"));
			expect(result.current.verificationFailure).toBeNull();
			expect(result.current.update).toBeNull();
		});

		test("is kept for a reader that mounts after the event", () => {
			const { result } = renderHook(() => useAppUpdate());
			downloadAndFail(result);

			// Settings > Updates opens long after the event arrived.
			expect(useUpdateVerificationStore.getState().failure).toEqual(FAILURE);
		});

		test("survives a reload: the snapshot read on mount feeds the store", async () => {
			snapshot = Promise.resolve(refused());
			const { result } = renderHook(() => useAppUpdate());

			await waitFor(() => expect(result.current.verificationFailure).toEqual(FAILURE));
			expect(useUpdateVerificationStore.getState().failure).toEqual(FAILURE);
			expect(result.current.update?.version).toBe("1.2.3");
		});

		test("unsubscribes on unmount", () => {
			const { unmount } = renderHook(() => useAppUpdate());
			expect(stateCb).not.toBeNull();
			unmount();
			expect(stateCb).toBeNull();
		});
	});

	describe("a download that failed (issue #3338)", () => {
		test("exposes the failure, shows the banner, and has no progress or restart", () => {
			const { result } = renderHook(() => useAppUpdate());
			announce();
			push(progress(60));
			push(failed());

			expect(result.current.downloadFailure).toEqual({
				version: "1.2.3",
				error: "net::ERR_INTERNET_DISCONNECTED",
			});
			expect(result.current.downloadProgress).toBeNull();
			expect(result.current.readyToInstall).toBe(false);
			expect(result.current.verificationFailure).toBeNull();
			expect(result.current.update?.version).toBe("1.2.3");
			expect(mockNotifyPost).not.toHaveBeenCalled();
		});

		test("brings back a banner dismissed during the download", () => {
			const { result } = renderHook(() => useAppUpdate());
			announce();
			push(progress(60));
			act(() => {
				result.current.dismiss();
			});
			push(failed());
			expect(result.current.update?.version).toBe("1.2.3");
		});

		test("a retried download takes the failure away", () => {
			const { result } = renderHook(() => useAppUpdate());
			announce();
			push(failed());
			expect(result.current.downloadFailure).not.toBeNull();

			push(downloading());
			expect(result.current.downloadFailure).toBeNull();
		});

		test("is still shown after a reload, named from the snapshot", async () => {
			snapshot = Promise.resolve(failed("2.0.0"));
			const { result } = renderHook(() => useAppUpdate());

			await waitFor(() => expect(result.current.downloadFailure?.version).toBe("2.0.0"));
			// `update:available` is not replayed, so the version can only come from
			// the snapshot.
			expect(result.current.update?.version).toBe("2.0.0");
		});
	});

	describe("a renderer that mounts with a download already in a state (issue #3338)", () => {
		test("offers the restart for a verified download without notifying again", async () => {
			snapshot = Promise.resolve(verified("2.0.0"));
			const { result } = renderHook(() => useAppUpdate());

			await waitFor(() => expect(result.current.readyToInstall).toBe(true));
			expect(result.current.update?.version).toBe("2.0.0");
			expect(mockNotifyPost).not.toHaveBeenCalled();

			// The same state pushed again is not a transition either.
			push(verified("2.0.0"));
			expect(mockNotifyPost).not.toHaveBeenCalled();
		});

		test("takes the rest of the update from the announcement when it arrives after the snapshot", async () => {
			snapshot = Promise.resolve(verified());
			const { result } = renderHook(() => useAppUpdate());
			await waitFor(() => expect(result.current.readyToInstall).toBe(true));

			announce();
			expect(result.current.update).toMatchObject({ version: "1.2.3", releaseUrl: "u" });
		});

		test("a push that lands before the answer is not overwritten by it", async () => {
			let answer: (state: UpdateDownloadState) => void = () => {};
			snapshot = new Promise((resolve) => {
				answer = resolve;
			});
			const { result } = renderHook(() => useAppUpdate());

			push(verified("2.0.0"));
			expect(mockNotifyPost).toHaveBeenCalledTimes(1);
			// The older answer: the download had not finished when it was read.
			await act(async () => {
				answer(downloading("2.0.0"));
				await snapshot;
			});
			expect(result.current.readyToInstall).toBe(true);
		});

		test("an answer that arrives after unmount is dropped", async () => {
			let answer: (state: UpdateDownloadState) => void = () => {};
			snapshot = new Promise((resolve) => {
				answer = resolve;
			});
			const { unmount } = renderHook(() => useAppUpdate());
			unmount();

			await act(async () => {
				answer(refused());
				await snapshot;
			});
			expect(useUpdateVerificationStore.getState().failure).toBeNull();
		});
	});
});
