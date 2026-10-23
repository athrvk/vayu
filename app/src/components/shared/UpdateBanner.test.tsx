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
 * wait, and the attestation failure that replaces "Restart & install"
 * (issue #2372). Driven through the preload callbacks the main process fires,
 * so the hook and the banner are tested as wired.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useUpdateVerificationStore } from "@/stores/update-verification-store";
import UpdateBanner from "./UpdateBanner";

vi.mock("@/services/notify", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/services/notify")>()),
	systemNotify: { post: vi.fn(), availability: vi.fn() },
}));

type Callback<T> = ((payload: T) => void) | null;

let available: Callback<{ version: string; strategy: "silent"; releaseUrl: string }>;
let progress: Callback<{ percent: number }>;
let downloaded: Callback<{ version: string }>;
let verificationFailed: Callback<{ version: string; reason: string }>;
const openReleasePage = vi.fn();
const restartToInstallUpdate = vi.fn();

const REASON = "GitHub has no attestation for this installer (HTTP 404).";

beforeEach(() => {
	available = progress = downloaded = verificationFailed = null;
	openReleasePage.mockReset();
	restartToInstallUpdate.mockReset();
	useUpdateVerificationStore.setState({ failure: null });
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		onUpdateAvailable: (cb: typeof available) => {
			available = cb;
			return () => {};
		},
		onDownloadProgress: (cb: typeof progress) => {
			progress = cb;
			return () => {};
		},
		onUpdateDownloaded: (cb: typeof downloaded) => {
			downloaded = cb;
			return () => {};
		},
		onUpdateVerificationFailed: (cb: typeof verificationFailed) => {
			verificationFailed = cb;
			return () => {};
		},
		openReleasePage,
		restartToInstallUpdate,
	};
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const announce = () =>
	act(() => {
		available?.({ version: "1.2.3", strategy: "silent", releaseUrl: "u" });
	});

describe("UpdateBanner", () => {
	it("says Verifying, not a percentage, once the download reaches 100%", async () => {
		render(<UpdateBanner />);
		announce();
		act(() => progress?.({ percent: 42 }));
		expect(await screen.findByText(/Downloading Vayu 1\.2\.3… 42%/)).toBeInTheDocument();

		act(() => progress?.({ percent: 100 }));
		expect(await screen.findByText("Verifying Vayu 1.2.3…")).toBeInTheDocument();
		expect(screen.queryByText(/100%/)).toBeNull();
	});

	it("names the version and the reason when the attestation did not verify", async () => {
		render(<UpdateBanner />);
		announce();
		act(() => progress?.({ percent: 100 }));
		act(() => verificationFailed?.({ version: "1.2.3", reason: REASON }));

		const message = await screen.findByText(`Couldn't verify Vayu 1.2.3. ${REASON}`);
		// `truncate` clips the line on a narrow window; the title keeps the reason.
		expect(message).toHaveAttribute("title", `Couldn't verify Vayu 1.2.3. ${REASON}`);
		expect(screen.queryByText(/Verifying/)).toBeNull();
	});

	it("offers the release page and no restart after a failed verification", async () => {
		render(<UpdateBanner />);
		announce();
		act(() => downloaded?.({ version: "1.2.3" }));
		expect(
			await screen.findByRole("button", { name: /restart & install/i })
		).toBeInTheDocument();

		act(() => verificationFailed?.({ version: "1.3.0", reason: REASON }));
		fireEvent.click(await screen.findByRole("button", { name: /view release/i }));
		expect(openReleasePage).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("button", { name: /restart & install/i })).toBeNull();
	});

	it("goes back to Restart & install when a later download verifies", async () => {
		render(<UpdateBanner />);
		announce();
		act(() => verificationFailed?.({ version: "1.2.3", reason: REASON }));
		expect(await screen.findByText(/Couldn't verify/)).toBeInTheDocument();

		act(() => downloaded?.({ version: "1.2.3" }));
		expect(
			await screen.findByRole("button", { name: /restart & install/i })
		).toBeInTheDocument();
		expect(screen.queryByText(/Couldn't verify/)).toBeNull();
	});
});
