/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The card's job is to tell the four outcomes apart. Getting that wrong is not
 * cosmetic — reporting "couldn't check" for a development build, or leaving a
 * stale "you're up to date" on screen while a new check runs, both say
 * something untrue about the user's install.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UpdatesCard } from "./UpdatesCard";

const checkForUpdates = vi.fn();
const openReleasePage = vi.fn();

beforeEach(() => {
	checkForUpdates.mockReset();
	openReleasePage.mockReset();
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		checkForUpdates,
		openReleasePage,
	};
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const clickCheck = async () => {
	// The handler is async, so the click has to be flushed inside act or the
	// assertions run against the pre-resolve render.
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));
	});
};

describe("UpdatesCard", () => {
	it("reports being up to date", async () => {
		checkForUpdates.mockResolvedValue({ status: "up-to-date", version: "0.9.0" });
		render(<UpdatesCard />);
		await clickCheck();
		expect(await screen.findByText(/up to date/i)).toBeInTheDocument();
	});

	it("offers the release notes when an update exists", async () => {
		checkForUpdates.mockResolvedValue({
			status: "available",
			version: "1.0.0",
			strategy: "notify",
			releaseUrl: "https://example.test/v1.0.0",
		});
		render(<UpdatesCard />);
		await clickCheck();
		fireEvent.click(await screen.findByRole("button", { name: /release notes/i }));
		expect(openReleasePage).toHaveBeenCalledWith("https://example.test/v1.0.0");
	});

	it("offers the install command only when the platform needs one", async () => {
		// macOS is ad-hoc signed and updates out-of-band, so it gets a command
		// to copy. Every other platform would be told to run a script it does
		// not need.
		checkForUpdates.mockResolvedValue({
			status: "available",
			version: "1.0.0",
			strategy: "silent",
			releaseUrl: "u",
		});
		const { unmount } = render(<UpdatesCard />);
		await clickCheck();
		expect(await screen.findByText(/is available/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /install command/i })).toBeNull();
		unmount();

		checkForUpdates.mockResolvedValue({
			status: "available",
			version: "1.0.0",
			strategy: "notify",
			releaseUrl: "u",
			installCommand: "curl … | bash",
		});
		render(<UpdatesCard />);
		await clickCheck();
		expect(await screen.findByRole("button", { name: /install command/i })).toBeInTheDocument();
	});

	it("does not call an unavailable build an error", async () => {
		checkForUpdates.mockResolvedValue({
			status: "unavailable",
			detail: "Update checks only run in packaged builds of Vayu.",
		});
		render(<UpdatesCard />);
		await clickCheck();
		expect(await screen.findByText(/only run in packaged builds/i)).toBeInTheDocument();
		expect(screen.queryByText(/couldn't check/i)).toBeNull();
	});

	it("shows the reason a check failed", async () => {
		checkForUpdates.mockResolvedValue({ status: "error", message: "getaddrinfo ENOTFOUND" });
		render(<UpdatesCard />);
		await clickCheck();
		expect(await screen.findByText(/getaddrinfo ENOTFOUND/)).toBeInTheDocument();
	});

	it("surfaces a rejected invoke rather than staying silent", async () => {
		// If the IPC channel is missing the promise rejects; without a catch the
		// button would spin forever with no explanation.
		checkForUpdates.mockRejectedValue(new Error("No handler registered"));
		render(<UpdatesCard />);
		await clickCheck();
		expect(await screen.findByText(/No handler registered/)).toBeInTheDocument();
	});

	it("clears the previous answer before the next check replies", async () => {
		checkForUpdates.mockResolvedValue({ status: "up-to-date", version: "0.9.0" });
		render(<UpdatesCard />);
		await clickCheck();
		expect(await screen.findByText(/up to date/i)).toBeInTheDocument();

		let release!: () => void;
		checkForUpdates.mockReturnValue(
			new Promise((resolve) => {
				release = () => resolve({ status: "error", message: "boom" });
			})
		);
		await clickCheck();
		// Mid-flight: the old answer must be gone, not still asserting the app
		// is current.
		expect(screen.queryByText(/up to date/i)).toBeNull();
		expect(screen.getByText(/Checking/)).toBeInTheDocument();
		release();
		await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
	});

	it("says so when running outside the desktop app", async () => {
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
		render(<UpdatesCard />);
		expect(screen.getByText(/available in the desktop app/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /check for updates/i })).toBeDisabled();
	});
});
