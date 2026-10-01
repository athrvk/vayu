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
 * The binary body editor, by what it writes.
 *
 * The trust rule hangs on one flag: the engine sends a file nobody chose in
 * the editor only from an allowed folder. So what is pinned here is who clears
 * `unresolved` (a pick, a drop, a typed path - all of them the user, here) and
 * who does not (a pick outside Electron, which yields a name and no path), and
 * that the banner offering the two ways out appears exactly when the engine
 * would refuse.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { FileRef, FileRoot, KeyValueItem } from "@/types";
import { RequestBuilderContext } from "../../../../context";
import type { RequestBuilderContextValue } from "../../../../types";
import { createDefaultRequestState } from "../../../../utils/request-state";

const roots: FileRoot[] = [];
const createRoot = vi.fn();

vi.mock("@/queries", () => ({
	useFileRootsQuery: () => ({ data: roots }),
	useCreateFileRootMutation: () => ({ mutateAsync: createRoot, isPending: false }),
}));
vi.mock("@/stores", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/stores")>()),
	useToastStore: (selector: (s: { showToast: () => void }) => unknown) =>
		selector({ showToast: vi.fn() }),
}));

const { default: BinaryBodyPanel } = await import("./BinaryBodyPanel");

let updateField: ReturnType<typeof vi.fn>;

function renderPanel(file: FileRef, headers: KeyValueItem[] = []) {
	const request = {
		...createDefaultRequestState(),
		bodyMode: "binary" as const,
		binaryFile: file,
		headers,
	};
	const value = {
		request,
		updateField,
		resolveString: (s: string) => s.split("{{dir}}").join("/fixtures"),
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		writableScopes: [],
		updateVariable: () => {},
	} as unknown as RequestBuilderContextValue;
	return render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={value}>
				<BinaryBodyPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
}

/** The last `binaryFile` the panel wrote. */
function written(): FileRef {
	const calls = updateField.mock.calls.filter(([field]) => field === "binaryFile");
	expect(calls.length).toBeGreaterThan(0);
	return calls[calls.length - 1][1] as FileRef;
}

function pickThroughInput(container: HTMLElement, file: File) {
	const input = container.querySelector('input[type="file"]') as HTMLInputElement;
	expect(input).not.toBeNull();
	fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
	updateField = vi.fn();
	roots.length = 0;
	createRoot.mockReset();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("choosing the file", () => {
	it("a pick in Electron writes the path and clears unresolved", () => {
		vi.stubGlobal("electronAPI", { getFilePath: () => "/home/me/a.bin" });
		const { container } = renderPanel({
			src: "/elsewhere/a.bin",
			contentType: "image/png",
			unresolved: true,
		});

		pickThroughInput(container, new File(["x"], "a.bin", { type: "text/plain" }));

		// The user's Content-Type survives; the browser's guess is not written.
		expect(written()).toEqual({
			src: "/home/me/a.bin",
			fileName: "a.bin",
			contentType: "image/png",
		});
	});

	it("a pick with no path to take stays unresolved", () => {
		vi.stubGlobal("electronAPI", undefined);
		const { container } = renderPanel({ src: "" });

		pickThroughInput(container, new File(["x"], "a.bin"));

		expect(written()).toEqual({ src: "", fileName: "a.bin", unresolved: true });
	});

	it("a drop is a pick", () => {
		vi.stubGlobal("electronAPI", { getFilePath: () => "/home/me/drop.bin" });
		renderPanel({ src: "/imported/drop.bin", unresolved: true });

		fireEvent.drop(screen.getByTestId("binary-drop-zone"), {
			dataTransfer: { files: [new File(["x"], "drop.bin")] },
		});

		expect(written()).toEqual({ src: "/home/me/drop.bin", fileName: "drop.bin" });
	});

	it("a typed path is the user's choice too", () => {
		renderPanel({ src: "/imported/a.bin", fileName: "a.bin", unresolved: true });

		fireEvent.change(screen.getByLabelText("File path"), {
			target: { value: "/mine/b.bin" },
		});

		expect(written()).toEqual({ src: "/mine/b.bin" });
	});

	it("a Content-Type typed here is written, and clearing it removes it", () => {
		renderPanel({ src: "/a.bin" });
		const field = screen.getByLabelText("Content-Type");

		fireEvent.change(field, { target: { value: "image/png" } });
		expect(written()).toEqual({ src: "/a.bin", contentType: "image/png" });
	});
});

describe("the unresolved banner", () => {
	it("offers Relink and Allow folder for a path nobody chose here", () => {
		renderPanel({ src: "/imported/data/a.bin", unresolved: true });

		expect(screen.getByText("Not chosen on this machine")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Relink" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Allow folder..." })).toBeInTheDocument();
	});

	it("is absent for a path chosen here", () => {
		renderPanel({ src: "/home/me/a.bin" });

		expect(screen.queryByText("Not chosen on this machine")).toBeNull();
		expect(screen.queryByRole("button", { name: "Relink" })).toBeNull();
	});

	it("appears for a path with a variable even when chosen here", () => {
		renderPanel({ src: "{{dir}}/a.bin" });

		expect(screen.getByText("Path has a variable")).toBeInTheDocument();
		// Nothing to relink: the user wrote this path on purpose.
		expect(screen.queryByRole("button", { name: "Relink" })).toBeNull();
	});

	it("says the file is covered once its folder is allowed", () => {
		roots.push({ id: "r1", path: "/fixtures", createdAt: 1 });
		renderPanel({ src: "{{dir}}/deep/a.bin" });

		expect(screen.queryByText("Path has a variable")).toBeNull();
		expect(screen.getByText(/this file is sent without picking it again/)).toBeInTheDocument();
	});

	it("Allow folder opens the picker at the file's folder inside Electron", async () => {
		const selectDirectory = vi.fn(async () => "/imported/data");
		vi.stubGlobal("electronAPI", { selectDirectory });
		createRoot.mockResolvedValue({ id: "r1", path: "/imported/data", createdAt: 1 });
		renderPanel({ src: "/imported/data/a.bin", unresolved: true });

		fireEvent.click(screen.getByRole("button", { name: "Allow folder..." }));

		await waitFor(() => expect(createRoot).toHaveBeenCalledWith("/imported/data"));
		expect(selectDirectory).toHaveBeenCalledWith({
			title: "Allow a folder",
			defaultPath: "/imported/data",
		});
	});

	it("Allow folder allows the file's folder directly where there is no picker", async () => {
		vi.stubGlobal("electronAPI", undefined);
		createRoot.mockResolvedValue({ id: "r1", path: "/imported/data", createdAt: 1 });
		renderPanel({ src: "/imported/data/a.bin", unresolved: true });

		fireEvent.click(screen.getByRole("button", { name: "Allow folder..." }));

		await waitFor(() => expect(createRoot).toHaveBeenCalledWith("/imported/data"));
	});
});

describe("what the panel says about the file", () => {
	it("shows the size the main process reports", async () => {
		const statFile = vi.fn(async () => ({ size: 2048, mtimeMs: 1 }));
		vi.stubGlobal("electronAPI", { statFile });
		renderPanel({ src: "/home/me/a.bin" });

		expect(await screen.findByText("2.0 KB")).toBeInTheDocument();
		expect(statFile).toHaveBeenCalledWith("/home/me/a.bin");
	});

	it("stats the resolved path of a templated one", async () => {
		const statFile = vi.fn(async () => null);
		vi.stubGlobal("electronAPI", { statFile });
		renderPanel({ src: "{{dir}}/a.bin" });

		expect(await screen.findByText("Not found on this machine")).toBeInTheDocument();
		expect(statFile).toHaveBeenCalledWith("/fixtures/a.bin");
	});

	it("names the Content-Type header when one is set, since it wins", async () => {
		renderPanel({ src: "/a.png", contentType: "image/png" }, [
			{ id: "h", key: "Content-Type", value: "application/x-custom", enabled: true },
		]);
		await act(async () => {});

		expect(screen.getByText("application/x-custom")).toBeInTheDocument();
		expect(
			screen.getByText(/the Content-Type header on the Headers tab wins/)
		).toBeInTheDocument();
	});

	it("says the extension decides when nothing else does", () => {
		renderPanel({ src: "/a.png" });

		expect(screen.getByText(/the type comes from the file extension/)).toBeInTheDocument();
	});
});
