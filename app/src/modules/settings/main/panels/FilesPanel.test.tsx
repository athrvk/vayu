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
 * What is pinned is what the panel asks for - the picker, never a typed path
 * (#2356), and the id a remove names - and the outcomes of an add, because a
 * 409 ("already allowed") is the result the user wanted and must not read as
 * a failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { FileRoot } from "@/types";

const roots: FileRoot[] = [];
let rootsFailed = false;
const allowRoot = vi.fn();
const deleteRoot = vi.fn();
const showToast = vi.fn();

vi.mock("@/queries", () => ({
	useFileRootsQuery: () => ({ data: roots, isLoading: false, isError: rootsFailed }),
	useAllowChosenFolderMutation: () => ({ mutateAsync: allowRoot, isPending: false }),
	useDeleteFileRootMutation: () => ({ mutateAsync: deleteRoot, isPending: false }),
}));
vi.mock("@/stores", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/stores")>()),
	useToastStore: (selector: (s: { showToast: typeof showToast }) => unknown) =>
		selector({ showToast }),
}));

const { default: FilesPanel } = await import("./FilesPanel");

const FILES_EMPTY_TITLE =
	"Files from an import, an agent or a data file are sent only from a folder you allow.";

function renderPanel() {
	return render(
		<TooltipProvider>
			<FilesPanel />
		</TooltipProvider>
	);
}

beforeEach(() => {
	roots.length = 0;
	rootsFailed = false;
	allowRoot.mockReset();
	// Inside Electron unless a case says otherwise: the bridge's presence is
	// what offers the picker, and the mutation above is what it would call.
	vi.stubGlobal("electronAPI", { allowFolder: vi.fn() });
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

	it("says the folders are unknown, with a next step, when the engine did not answer", () => {
		rootsFailed = true;
		renderPanel();

		// The empty-state sentence would be a claim the panel cannot make here.
		expect(screen.queryByText(FILES_EMPTY_TITLE)).not.toBeInTheDocument();
		expect(screen.getByText(/didn't answer/i)).toHaveTextContent("Restart Vayu");
	});

	it("says so when nothing is allowed", () => {
		const { container } = renderPanel();
		expect(screen.getByText(FILES_EMPTY_TITLE)).toBeInTheDocument();
		// Through the primitive, not a bare <p> that drifts from the other empty states.
		expect(container.querySelector('[data-slot="empty-state"]')).toHaveTextContent(
			FILES_EMPTY_TITLE
		);
	});

	it("allows the folder chosen in the picker", async () => {
		allowRoot.mockResolvedValue({
			outcome: "done",
			path: "/picked/",
			value: { id: "r1", path: "/picked", createdAt: 1 },
		});
		renderPanel();

		fireEvent.click(screen.getByRole("button", { name: "Choose folder..." }));

		await waitFor(() => expect(allowRoot).toHaveBeenCalledWith({ title: "Allow a folder" }));
		// The row the engine kept, canonical, not the folder as picked.
		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				"Files under /picked can be sent now.",
				"success"
			)
		);
	});

	it("offers no field to type a folder into", () => {
		renderPanel();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
	});

	it("treats an already-allowed folder as done, not as an error", async () => {
		allowRoot.mockResolvedValue({
			outcome: "refused",
			path: "/data",
			status: 409,
			code: "conflict",
			message: "The folder '/data' is already allowed (id r1)",
		});
		renderPanel();

		fireEvent.click(screen.getByRole("button", { name: "Choose folder..." }));

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith("/data is already an allowed folder.", "info")
		);
	});

	it("shows the engine's reason when it refuses a folder", async () => {
		allowRoot.mockResolvedValue({
			outcome: "refused",
			path: "/home/ada",
			status: 400,
			code: "invalid_request",
			message: "'/home/ada' is your home folder",
		});
		renderPanel();

		fireEvent.click(screen.getByRole("button", { name: "Choose folder..." }));

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				"Couldn't allow /home/ada: '/home/ada' is your home folder",
				"error"
			)
		);
	});

	it("says the engine did not answer when it could not be asked", async () => {
		allowRoot.mockResolvedValue({ outcome: "unreachable", path: "/data", message: "x" });
		renderPanel();

		fireEvent.click(screen.getByRole("button", { name: "Choose folder..." }));

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				expect.stringMatching(/^Couldn't allow \/data: .*Restart Vayu\.$/),
				"error"
			)
		);
	});

	it("says nothing when the picker is cancelled", async () => {
		allowRoot.mockResolvedValue({ outcome: "cancelled" });
		renderPanel();

		fireEvent.click(screen.getByRole("button", { name: "Choose folder..." }));

		await waitFor(() => expect(allowRoot).toHaveBeenCalled());
		expect(showToast).not.toHaveBeenCalled();
	});

	it("removes a folder by its id", async () => {
		roots.push({ id: "r1", path: "/data/fixtures", createdAt: 1 });
		deleteRoot.mockResolvedValue(undefined);
		renderPanel();

		fireEvent.click(screen.getByRole("button", { name: "Remove /data/fixtures" }));

		await waitFor(() => expect(deleteRoot).toHaveBeenCalledWith("r1"));
	});

	it("offers no picker outside Electron, where nothing may allow a folder", () => {
		vi.stubGlobal("electronAPI", undefined);
		renderPanel();
		expect(screen.queryByRole("button", { name: "Choose folder..." })).toBeNull();
	});

	it("declares the surface its folder dividers read", () => {
		roots.push(
			{ id: "r1", path: "/data/fixtures", createdAt: 1 },
			{ id: "r2", path: "C:\\uploads", createdAt: 2 }
		);
		const { container } = renderPanel();
		const rules = Array.from(container.querySelectorAll(".border-rule"));

		// One divider per allowed folder.
		// A render that reached no divider would pass the loop below having
		// checked nothing.
		expect(rules.length).toBeGreaterThanOrEqual(2);
		for (const rule of rules) {
			expect(
				rule.closest(".surface-card, .surface-sunken"),
				`border-rule under no surface: ${rule.getAttribute("class")}`
			).not.toBeNull();
		}
	});
});
