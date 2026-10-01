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
 * Settings > Files: the engine's allowed folders, listed, added and removed.
 *
 * What is pinned is what reaches the engine - the path a POST carries, the id
 * a DELETE names - and the three outcomes of an add, because a 409 ("already
 * allowed") is the result the user wanted and must not read as a failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { ApiError } from "@/services/http-client";
import type { FileRoot } from "@/types";

const roots: FileRoot[] = [];
const createRoot = vi.fn();
const deleteRoot = vi.fn();
const showToast = vi.fn();

vi.mock("@/queries", () => ({
	useFileRootsQuery: () => ({ data: roots, isLoading: false, isError: false }),
	useCreateFileRootMutation: () => ({ mutateAsync: createRoot, isPending: false }),
	useDeleteFileRootMutation: () => ({ mutateAsync: deleteRoot, isPending: false }),
}));
vi.mock("@/stores", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/stores")>()),
	useToastStore: (selector: (s: { showToast: typeof showToast }) => unknown) =>
		selector({ showToast }),
}));

const { default: FilesPanel } = await import("./FilesPanel");

function renderPanel() {
	return render(
		<TooltipProvider>
			<FilesPanel />
		</TooltipProvider>
	);
}

beforeEach(() => {
	roots.length = 0;
	createRoot.mockReset();
	deleteRoot.mockReset();
	showToast.mockReset();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("FilesPanel", () => {
	it("lists every allowed folder the engine returned", () => {
		roots.push(
			{ id: "r1", path: "/data/fixtures", createdAt: 1 },
			{ id: "r2", path: "C:\\uploads", createdAt: 2 }
		);
		renderPanel();

		const list = screen.getByRole("list", { name: "Allowed folders" });
		expect(list.querySelectorAll("li")).toHaveLength(2);
		expect(screen.getByText("/data/fixtures")).toBeInTheDocument();
		expect(screen.getByText("C:\\uploads")).toBeInTheDocument();
	});

	it("says so when nothing is allowed", () => {
		renderPanel();
		expect(screen.getByText("No folders allowed yet.")).toBeInTheDocument();
	});

	it("allows a typed folder by posting its path", async () => {
		createRoot.mockResolvedValue({ id: "r1", path: "/data/fixtures", createdAt: 1 });
		renderPanel();

		fireEvent.change(screen.getByLabelText("Folder to allow"), {
			target: { value: "  /data/fixtures  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));

		await waitFor(() => expect(createRoot).toHaveBeenCalledWith("/data/fixtures"));
		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				"Files under /data/fixtures can be sent now.",
				"success"
			)
		);
		expect(screen.getByLabelText("Folder to allow")).toHaveValue("");
	});

	it("treats an already-allowed folder as done, not as an error", async () => {
		createRoot.mockRejectedValue(new ApiError(409, "conflict", "already allowed"));
		renderPanel();

		fireEvent.change(screen.getByLabelText("Folder to allow"), {
			target: { value: "/data" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith("/data is already an allowed folder.", "info")
		);
	});

	it("shows the engine's reason when it refuses a folder, and keeps the text", async () => {
		createRoot.mockRejectedValue(
			new ApiError(400, "invalid_request", "'/nope' is not an existing directory")
		);
		renderPanel();

		fireEvent.change(screen.getByLabelText("Folder to allow"), {
			target: { value: "/nope" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				"Couldn't allow /nope: '/nope' is not an existing directory",
				"error"
			)
		);
		expect(screen.getByLabelText("Folder to allow")).toHaveValue("/nope");
	});

	it("removes a folder by its id", async () => {
		roots.push({ id: "r1", path: "/data/fixtures", createdAt: 1 });
		deleteRoot.mockResolvedValue(undefined);
		renderPanel();

		fireEvent.click(screen.getByRole("button", { name: "Remove /data/fixtures" }));

		await waitFor(() => expect(deleteRoot).toHaveBeenCalledWith("r1"));
	});

	it("offers the folder picker inside Electron and allows what it returns", async () => {
		const selectDirectory = vi.fn(async () => "/picked");
		vi.stubGlobal("electronAPI", { selectDirectory });
		createRoot.mockResolvedValue({ id: "r1", path: "/picked", createdAt: 1 });
		renderPanel();

		fireEvent.click(screen.getByRole("button", { name: "Choose folder..." }));

		await waitFor(() => expect(createRoot).toHaveBeenCalledWith("/picked"));
		expect(selectDirectory).toHaveBeenCalledWith({ title: "Allow a folder" });
	});

	it("posts nothing when the picker is cancelled", async () => {
		const selectDirectory = vi.fn(async () => null);
		vi.stubGlobal("electronAPI", { selectDirectory });
		renderPanel();

		fireEvent.click(screen.getByRole("button", { name: "Choose folder..." }));

		await waitFor(() => expect(selectDirectory).toHaveBeenCalled());
		expect(createRoot).not.toHaveBeenCalled();
	});

	it("offers no picker outside Electron, where there is none to open", () => {
		vi.stubGlobal("electronAPI", undefined);
		renderPanel();
		expect(screen.queryByRole("button", { name: "Choose folder..." })).toBeNull();
		// The typed path still works there.
		expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
	});
});
