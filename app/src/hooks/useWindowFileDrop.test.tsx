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
 * A file dropped anywhere on the window opens the Import dialog with it
 * (#2252). The dialog's own dropzone and `BinaryBodyPanel` handle their drops
 * themselves, so a drop they already cancelled is not this hook's to take.
 */

import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useImportModalStore } from "@/stores";

import { useWindowFileDrop } from "./useWindowFileDrop";

afterEach(() => {
	useImportModalStore.setState({ isOpen: false, pendingPath: null, pendingFiles: [] });
});

/** jsdom has no DataTransfer; the hook reads only `types` and `files`. */
function dragEvent(type: "dragover" | "drop", types: string[], files: File[] = []): DragEvent {
	const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, "dataTransfer", { value: { types, files } });
	return event;
}

describe("useWindowFileDrop", () => {
	it("opens the dialog with the files of a drop", () => {
		renderHook(() => useWindowFileDrop());
		const file = new File(["{}"], "export.json");

		const event = dragEvent("drop", ["Files"], [file]);
		window.dispatchEvent(event);

		const state = useImportModalStore.getState();
		expect(state.isOpen).toBe(true);
		expect(state.pendingFiles).toEqual([file]);
		expect(event.defaultPrevented).toBe(true);
	});

	/*
	 * Mutation check: drop the `defaultPrevented` guard and the dialog's own
	 * dropzone drop also opens it a second time with the same files.
	 */
	it("leaves a drop that something else already cancelled", () => {
		renderHook(() => useWindowFileDrop());
		const handled = (e: Event) => e.preventDefault();
		document.body.addEventListener("drop", handled);

		const event = dragEvent("drop", ["Files"], [new File(["{}"], "export.json")]);
		document.body.dispatchEvent(event);
		document.body.removeEventListener("drop", handled);

		expect(useImportModalStore.getState().isOpen).toBe(false);
		expect(useImportModalStore.getState().pendingFiles).toEqual([]);
	});

	it("ignores a drag that carries text, not files", () => {
		renderHook(() => useWindowFileDrop());

		const event = dragEvent("drop", ["text/plain"]);
		window.dispatchEvent(event);

		expect(useImportModalStore.getState().isOpen).toBe(false);
		expect(event.defaultPrevented).toBe(false);
	});

	it("does not open the dialog for a drop with no files in it", () => {
		renderHook(() => useWindowFileDrop());

		window.dispatchEvent(dragEvent("drop", ["Files"], []));

		expect(useImportModalStore.getState().isOpen).toBe(false);
	});

	it("accepts a dragover only when it carries files", () => {
		renderHook(() => useWindowFileDrop());

		const files = dragEvent("dragover", ["Files"]);
		const text = dragEvent("dragover", ["text/plain"]);
		window.dispatchEvent(files);
		window.dispatchEvent(text);

		expect(files.defaultPrevented).toBe(true);
		expect(text.defaultPrevented).toBe(false);
	});

	it("stops listening on unmount", () => {
		const { unmount } = renderHook(() => useWindowFileDrop());
		unmount();

		window.dispatchEvent(dragEvent("drop", ["Files"], [new File(["{}"], "export.json")]));

		expect(useImportModalStore.getState().isOpen).toBe(false);
	});
});
