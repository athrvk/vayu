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
 * The banner's silent-path states that follow the download: the verification
 * wait, the attestation failure that replaces "Restart & install"
 * (issue #2372), and a download that failed, which offers Retry (issue #3338).
 * Driven through the preload callbacks the main process fires, so the hook and
 * the banner are tested as wired.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useUpdateVerificationStore } from "@/stores/update-verification-store";
import type { UpdateDownloadState } from "@/types/electron";
import UpdateBanner from "./UpdateBanner";

vi.mock("@/services/notify", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/services/notify")>()),
	systemNotify: { post: vi.fn(), availability: vi.fn() },
}));

type Callback<T> = ((payload: T) => void) | null;

let available: Callback<{ version: string; strategy: "silent"; releaseUrl: string }>;
let downloadState: Callback<UpdateDownloadState>;
const openReleasePage = vi.fn();
const restartToInstallUpdate = vi.fn();
const checkForUpdates = vi.fn();

const REASON = "GitHub has no attestation for this installer (HTTP 404).";

beforeEach(() => {
	available = downloadState = null;
	openReleasePage.mockReset();
	restartToInstallUpdate.mockReset();
	checkForUpdates.mockReset();
	checkForUpdates.mockResolvedValue({ status: "up-to-date", version: "1.0.0" });
	useUpdateVerificationStore.setState({ failure: null });
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		onUpdateAvailable: (cb: typeof available) => {
			available = cb;
			return () => {};
		},
		onUpdateState: (cb: typeof downloadState) => {
			downloadState = cb;
			return () => {};
		},
		getUpdateState: () => Promise.resolve({ kind: "none" }),
		openReleasePage,
		restartToInstallUpdate,
		checkForUpdates,
	};
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const announce = () =>
	act(() => {
		available?.({ version: "1.2.3", strategy: "silent", releaseUrl: "u" });
	});
const push = (state: UpdateDownloadState) => act(() => downloadState?.(state));
const downloading = (percent: number): UpdateDownloadState => ({
	kind: "downloading",
	version: "1.2.3",
	progress: { percent, bytesPerSecond: 1, transferred: 1, total: 1 },
});
const verified: UpdateDownloadState = { kind: "verified", version: "1.2.3" };
const refused = (version: string): UpdateDownloadState => ({
	kind: "refused",
	version,
	reason: REASON,
});
const failed: UpdateDownloadState = {
	kind: "failed",
	version: "1.2.3",
	error: "net::ERR_INTERNET_DISCONNECTED",
};

describe("UpdateBanner", () => {
	it("says Verifying, not a percentage, once the download reaches 100%", async () => {
		render(<UpdateBanner />);
		announce();
		push(downloading(42));
		expect(await screen.findByText(/Downloading Vayu 1\.2\.3… 42%/)).toBeInTheDocument();

		push({ kind: "verifying", version: "1.2.3" });
		expect(await screen.findByText("Verifying Vayu 1.2.3…")).toBeInTheDocument();
		expect(screen.queryByText(/100%/)).toBeNull();
	});

	it("names the version and the reason when the attestation did not verify", async () => {
		render(<UpdateBanner />);
		announce();
		push({ kind: "verifying", version: "1.2.3" });
		push(refused("1.2.3"));

		const message = await screen.findByText(`Couldn't verify Vayu 1.2.3. ${REASON}`);
		// `truncate` clips the line on a narrow window; the title keeps the reason.
		expect(message).toHaveAttribute("title", `Couldn't verify Vayu 1.2.3. ${REASON}`);
		expect(screen.queryByText(/Verifying/)).toBeNull();
	});

	it("offers the release page and no restart after a failed verification", async () => {
		render(<UpdateBanner />);
		announce();
		push(verified);
		expect(
			await screen.findByRole("button", { name: /restart & install/i })
		).toBeInTheDocument();

		push(refused("1.3.0"));
		fireEvent.click(await screen.findByRole("button", { name: /view release/i }));
		expect(openReleasePage).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("button", { name: /restart & install/i })).toBeNull();
	});

	it("goes back to Restart & install when a later download verifies", async () => {
		render(<UpdateBanner />);
		announce();
		push(refused("1.2.3"));
		expect(await screen.findByText(/Couldn't verify/)).toBeInTheDocument();

		push(verified);
		expect(
			await screen.findByRole("button", { name: /restart & install/i })
		).toBeInTheDocument();
		expect(screen.queryByText(/Couldn't verify/)).toBeNull();
	});

	describe("a download that failed (issue #3338)", () => {
		it("says so, names the cause, and drops the progress bar", async () => {
			render(<UpdateBanner />);
			announce();
			push(downloading(60));
			expect(await screen.findByRole("progressbar")).toBeInTheDocument();

			push(failed);
			const text = "Couldn't download Vayu 1.2.3 - net::ERR_INTERNET_DISCONNECTED";
			const message = await screen.findByText(text);
			expect(message).toHaveAttribute("title", text);
			expect(screen.queryByRole("progressbar")).toBeNull();
			expect(screen.queryByText(/Downloading/)).toBeNull();
		});

		it("offers Retry, which asks for a new check, and no restart", async () => {
			render(<UpdateBanner />);
			announce();
			push(failed);

			fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
			expect(checkForUpdates).toHaveBeenCalledTimes(1);
			expect(screen.queryByRole("button", { name: /restart & install/i })).toBeNull();
			expect(screen.queryByRole("button", { name: /view release/i })).toBeNull();
		});

		it("takes the failure and Retry away once the retried download starts", async () => {
			render(<UpdateBanner />);
			announce();
			push(failed);
			expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();

			push(downloading(5));
			expect(await screen.findByText(/Downloading Vayu 1\.2\.3… 5%/)).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
		});
	});
});
