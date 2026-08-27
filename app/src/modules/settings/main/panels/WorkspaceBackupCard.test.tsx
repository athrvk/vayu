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
 * The workspace backup card (issue #987).
 *
 * Three things this card can get wrong and no other test would catch:
 *
 *  - **The path must survive on screen.** Restoring is a manual file copy, so a
 *    card that only toasts leaves the user with nowhere to look afterwards.
 *  - **A 409 is not a failure.** "A backup is already running" means their own
 *    earlier request is still writing the file; reporting it as an error sends
 *    them hunting for a problem that does not exist.
 *  - **A real failure must be visible**, not swallowed into a toast that fades.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { ApiError } from "@/services/http-client";
import { WorkspaceBackupCard } from "./WorkspaceBackupCard";

const backupWorkspace = vi.fn();
const showToast = vi.fn();

vi.mock("@/services", () => ({
	apiService: {
		backupWorkspace: (...args: unknown[]) => backupWorkspace(...args),
	},
}));

vi.mock("@/stores", () => ({
	useToastStore: (selector: (s: { showToast: typeof showToast }) => unknown) =>
		selector({ showToast }),
}));

const SNAPSHOT = {
	path: "/home/someone/.vayu/backups/vayu-20260827-120000-000.db",
	sizeBytes: 2_097_152,
	createdAt: 1_787_745_600_000,
	pruned: 2,
};

beforeEach(() => {
	backupWorkspace.mockReset();
	showToast.mockReset();
});

/** Press the card's one button. */
function backUp() {
	fireEvent.click(screen.getByRole("button", { name: /back up now/i }));
}

describe("WorkspaceBackupCard", () => {
	it("shows the path, size and what retention removed", async () => {
		backupWorkspace.mockResolvedValue(SNAPSHOT);
		render(<WorkspaceBackupCard />);
		backUp();

		// The path itself, not a summary of it: this is what the user copies.
		expect(await screen.findByText(SNAPSHOT.path)).toBeInTheDocument();
		expect(screen.getByText(/2\.0 MB/)).toBeInTheDocument();
		expect(screen.getByText(/removed 2 older snapshots/)).toBeInTheDocument();
		expect(showToast).toHaveBeenCalledWith("Workspace backed up", "success");
	});

	it("does not claim to have removed anything when it removed nothing", async () => {
		backupWorkspace.mockResolvedValue({ ...SNAPSHOT, pruned: 0 });
		render(<WorkspaceBackupCard />);
		backUp();

		await screen.findByText(SNAPSHOT.path);
		expect(screen.queryByText(/removed/)).not.toBeInTheDocument();
	});

	it("prints the restore procedure beside the file it applies to", async () => {
		backupWorkspace.mockResolvedValue(SNAPSHOT);
		render(<WorkspaceBackupCard />);
		backUp();

		await screen.findByText(SNAPSHOT.path);
		// There is no restore button by design - a live engine overwriting its
		// own open database is the footgun this feature avoids - so the steps
		// have to be here.
		expect(
			screen.getByText(/quit Vayu, copy this file over the database/i)
		).toBeInTheDocument();
	});

	it("reads a 409 as a backup already running, not as a failure of this one", async () => {
		backupWorkspace.mockRejectedValue(
			new ApiError(409, "CONFLICT", "A workspace backup is already running")
		);
		render(<WorkspaceBackupCard />);
		backUp();

		expect(
			await screen.findByText(/already running - it will finish on its own/i)
		).toBeInTheDocument();
		// And it does not present the engine's raw sentence, which reads as an
		// error where this is a state.
		expect(screen.queryByText(/could not/i)).not.toBeInTheDocument();
	});

	it("shows a real failure on the card rather than only in a toast", async () => {
		backupWorkspace.mockRejectedValue(
			new ApiError(500, "INTERNAL", "Could not write the backup to /nowhere: disk full")
		);
		render(<WorkspaceBackupCard />);
		backUp();

		expect(await screen.findByText(/disk full/)).toBeInTheDocument();
		expect(showToast).toHaveBeenCalledWith("Could not back up the workspace", "error");
	});

	it("clears a previous failure when a retry succeeds", async () => {
		backupWorkspace.mockRejectedValueOnce(new ApiError(500, "INTERNAL", "disk full"));
		render(<WorkspaceBackupCard />);
		backUp();
		await screen.findByText(/disk full/);

		backupWorkspace.mockResolvedValue(SNAPSHOT);
		backUp();

		await screen.findByText(SNAPSHOT.path);
		await waitFor(() => expect(screen.queryByText(/disk full/)).not.toBeInTheDocument());
	});
});
