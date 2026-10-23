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
 * The binary body editor, by what it writes and what it warns about.
 *
 * The engine sends a file picked on this machine or one under an allowed
 * folder, and says which on every read (`unresolved`, #2356). The editor shows
 * that answer, and between reads holds one of its own: a pick or a drop sets
 * `false` (the pick is the grant), a typed path sets nothing and reads as not
 * chosen. The banner offering the two ways out appears exactly when the engine
 * would refuse.
 */

import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { FileRef, FileRoot, KeyValueItem } from "@/types";
import { RequestBuilderContext } from "../../../../context";
import type { RequestBuilderContextValue } from "../../../../types";
import { createDefaultRequestState } from "../../../../utils/request-state";

const roots: FileRoot[] = [];
const allowRoot = vi.fn();

vi.mock("@/queries", () => ({
	useFileRootsQuery: () => ({ data: roots }),
	useAllowChosenFolderMutation: () => ({ mutateAsync: allowRoot, isPending: false }),
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

/** The panel over live state, so a write shows on screen as it would in the editor. */
function renderLive(initial: FileRef) {
	function Live() {
		const [file, setFile] = useState(initial);
		const request = {
			...createDefaultRequestState(),
			bodyMode: "binary" as const,
			binaryFile: file,
		};
		const value = {
			request,
			updateField: (field: string, next: FileRef) => {
				if (field === "binaryFile") setFile(next);
			},
			resolveString: (s: string) => s,
			getAllVariables: () => ({}),
			getVariableOrigins: () => [],
			writableScopes: [],
			updateVariable: () => {},
		} as unknown as RequestBuilderContextValue;
		return (
			<RequestBuilderContext.Provider value={value}>
				<BinaryBodyPanel />
			</RequestBuilderContext.Provider>
		);
	}
	return render(
		<TooltipProvider>
			<Live />
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
	allowRoot.mockReset();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("choosing the file", () => {
	it("a pick in Electron writes the path and unresolved false", () => {
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
			unresolved: false,
		});
	});

	it("a pick with no path to take leaves no flag", () => {
		vi.stubGlobal("electronAPI", undefined);
		const { container } = renderPanel({ src: "", unresolved: true });

		pickThroughInput(container, new File(["x"], "a.bin"));

		expect(written()).toEqual({ src: "", fileName: "a.bin" });
		expect(written().unresolved).toBeUndefined();
	});

	it("a drop is a pick", () => {
		vi.stubGlobal("electronAPI", { getFilePath: () => "/home/me/drop.bin" });
		renderPanel({ src: "/imported/drop.bin", unresolved: true });

		fireEvent.drop(screen.getByTestId("binary-drop-zone"), {
			dataTransfer: { files: [new File(["x"], "drop.bin")] },
		});

		expect(written()).toEqual({
			src: "/home/me/drop.bin",
			fileName: "drop.bin",
			unresolved: false,
		});
	});

	// Typing a path is not picking it (#2356): the engine's earlier answer
	// belonged to the old path, and a typed one has none until the next read.
	it("a typed path drops the engine's answer and claims none", () => {
		renderPanel({ src: "/imported/a.bin", fileName: "a.bin", unresolved: false });

		fireEvent.change(screen.getByLabelText("File path"), {
			target: { value: "/mine/b.bin" },
		});

		expect(written()).toEqual({ src: "/mine/b.bin" });
		expect(written()).not.toHaveProperty("unresolved");
	});

	it("a Content-Type typed here is written, and clearing it removes it", () => {
		renderPanel({ src: "/a.bin", unresolved: false });
		const field = screen.getByLabelText("Content-Type");
		fireEvent.change(field, { target: { value: "image/png" } });
		expect(written()).toEqual({ src: "/a.bin", contentType: "image/png", unresolved: false });
	});
});

describe("the unresolved banner", () => {
	it("offers Relink and Allow folder for a path the engine says it would refuse", () => {
		vi.stubGlobal("electronAPI", { allowFolder: vi.fn() });
		renderPanel({ src: "/imported/data/a.bin", unresolved: true });

		expect(screen.getByText("Not chosen on this machine")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Relink" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Allow folder…" })).toBeInTheDocument();
	});

	it("is absent for a path the engine says it would send", () => {
		renderPanel({ src: "/home/me/a.bin", unresolved: false });

		expect(screen.queryByText("Not chosen on this machine")).toBeNull();
		expect(screen.queryByRole("button", { name: "Relink" })).toBeNull();
	});

	it("appears for a typed path, and a pick clears it", () => {
		vi.stubGlobal("electronAPI", { getFilePath: () => "/home/me/b.bin" });
		const { container } = renderLive({ src: "" });
		expect(screen.queryByText("Not chosen on this machine")).toBeNull();

		fireEvent.change(screen.getByLabelText("File path"), {
			target: { value: "/home/me/b.bin" },
		});
		expect(screen.getByText("Not chosen on this machine")).toBeInTheDocument();

		pickThroughInput(container, new File(["x"], "b.bin"));
		expect(screen.queryByText("Not chosen on this machine")).toBeNull();
	});

	it("is absent after a pick, before the engine has answered", () => {
		vi.stubGlobal("electronAPI", { getFilePath: () => "/home/me/a.bin" });
		const { container } = renderLive({ src: "/elsewhere/a.bin", unresolved: true });
		expect(screen.getByText("Not chosen on this machine")).toBeInTheDocument();

		pickThroughInput(container, new File(["x"], "a.bin"));

		expect(screen.queryByText("Not chosen on this machine")).toBeNull();
	});

	it("appears for a path with a variable even when chosen here", () => {
		renderPanel({ src: "{{dir}}/a.bin", unresolved: false });

		expect(screen.getByText("Path has a variable")).toBeInTheDocument();
		// Nothing to relink: the user wrote this path on purpose.
		expect(screen.queryByRole("button", { name: "Relink" })).toBeNull();
	});

	it("says the file is covered once its folder is allowed", () => {
		roots.push({ id: "r1", path: "/fixtures", createdAt: 1 });
		renderPanel({ src: "{{dir}}/deep/a.bin", unresolved: false });

		expect(screen.queryByText("Path has a variable")).toBeNull();
		expect(screen.getByText(/this file is sent without picking it again/)).toBeInTheDocument();
	});

	it("Allow folder opens the picker with no folder hint inside Electron", async () => {
		vi.stubGlobal("electronAPI", { allowFolder: vi.fn() });
		allowRoot.mockResolvedValue({
			outcome: "done",
			path: "/imported/data",
			value: { id: "r1", path: "/imported/data", createdAt: 1 },
		});
		renderPanel({ src: "/imported/data/a.bin", unresolved: true });

		fireEvent.click(screen.getByRole("button", { name: "Allow folder…" }));

		await waitFor(() => expect(allowRoot).toHaveBeenCalledWith());
	});

	// #2356: the renderer cannot allow a folder it names, so with no picker
	// there is nothing to offer. Relink still is.
	it("offers no Allow folder where there is no picker", () => {
		vi.stubGlobal("electronAPI", undefined);
		renderPanel({ src: "/imported/data/a.bin", unresolved: true });

		expect(screen.queryByRole("button", { name: "Allow folder…" })).toBeNull();
		expect(screen.getByRole("button", { name: "Relink" })).toBeInTheDocument();
		expect(allowRoot).not.toHaveBeenCalled();
	});
});

describe("what the panel says about the file", () => {
	it("shows the size the main process reports", async () => {
		const statFile = vi.fn(async () => ({ size: 2048, mtimeMs: 1 }));
		vi.stubGlobal("electronAPI", { statFile });
		renderPanel({ src: "/home/me/a.bin", unresolved: false });

		expect(await screen.findByText("2.0 KB")).toBeInTheDocument();
		expect(statFile).toHaveBeenCalledWith("/home/me/a.bin");
	});

	it("stats the resolved path of a templated one", async () => {
		const statFile = vi.fn(async () => null);
		vi.stubGlobal("electronAPI", { statFile });
		renderPanel({ src: "{{dir}}/a.bin", unresolved: false });

		expect(await screen.findByText("Not found on this machine")).toBeInTheDocument();
		expect(statFile).toHaveBeenCalledWith("/fixtures/a.bin");
	});

	it("names the Content-Type header when one is set, since it wins", async () => {
		renderPanel({ src: "/a.png", contentType: "image/png", unresolved: false }, [
			{ id: "h", key: "Content-Type", value: "application/x-custom", enabled: true },
		]);
		await act(async () => {});

		expect(screen.getByText("application/x-custom")).toBeInTheDocument();
		expect(
			screen.getByText(/the Content-Type header on the Headers tab wins/)
		).toBeInTheDocument();
	});

	it("says the extension decides when nothing else does", () => {
		renderPanel({ src: "/a.png", unresolved: false });

		expect(screen.getByText(/the type comes from the file extension/)).toBeInTheDocument();
	});
});
