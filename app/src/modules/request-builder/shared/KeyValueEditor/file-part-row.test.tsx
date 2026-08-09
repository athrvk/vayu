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
 * The form-data file row (issue #393), through the editor that owns it.
 *
 * Driven from `KeyValueEditor` rather than from `KeyValueRow`, because the
 * behaviour worth pinning is what the *list* becomes: picking a file writes
 * four members of one row at once (four separate updates would each rebuild
 * from a stale list and only the last would survive), and switching a row back
 * to text has to clear them - a text row still carrying a `src` is a body the
 * engine refuses, and the user would never see why.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import KeyValueEditor from "./index";
import type { KeyValueItem } from "../../types";

vi.mock("../../context/RequestBuilderContext", () => ({
	useRequestBuilderContext: () => ({
		resolveString: (s: string) => s,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		writableScopes: [],
		updateVariable: () => {},
	}),
}));

afterEach(() => {
	vi.unstubAllGlobals();
});

function editor(items: KeyValueItem[], allowFiles = true) {
	const onChange = vi.fn<(items: KeyValueItem[]) => void>();
	const { container } = render(
		<TooltipProvider>
			<KeyValueEditor items={items} onChange={onChange} allowFiles={allowFiles} />
		</TooltipProvider>
	);
	return { container, onChange };
}

const textRow: KeyValueItem = { id: "r1", key: "avatar", value: "", enabled: true };
const fileRow: KeyValueItem = {
	id: "r1",
	key: "avatar",
	value: "",
	enabled: true,
	type: "file",
	src: "/tmp/a.png",
	fileName: "a.png",
};

function kindButton(container: HTMLElement): HTMLButtonElement {
	const button = container.querySelector<HTMLButtonElement>(
		'button[aria-label^="Send avatar as"]'
	);
	if (!button) throw new Error("no kind toggle rendered - the row markup changed");
	return button;
}

describe("switching a row between text and file", () => {
	it("offers the switch only where a file can actually be sent", () => {
		// urlencoded's wire body is a string of pairs and the engine refuses a
		// file part there, so the affordance must not exist on that table.
		const { container } = editor([textRow], false);
		expect(container.querySelector('button[aria-label^="Send avatar as"]')).toBeNull();
	});

	it("turns a text row into a file row", () => {
		const { container, onChange } = editor([textRow]);
		fireEvent.click(kindButton(container));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0][0][0]).toMatchObject({ id: "r1", type: "file" });
	});

	it("drops the file members when the row goes back to text", () => {
		const { container, onChange } = editor([{ ...fileRow, unresolved: true }]);
		fireEvent.click(kindButton(container));

		const row = onChange.mock.calls[0][0][0];
		expect(row.type).toBe("text");
		// Not merely hidden: a text row carrying a `src` is refused by the engine
		// as a file the caller pointed at and nothing sends.
		expect(row.src).toBeUndefined();
		expect(row.fileName).toBeUndefined();
		expect(row.contentType).toBeUndefined();
		expect(row.unresolved).toBeUndefined();
	});
});

describe("picking a file", () => {
	function pick(container: HTMLElement, file: File) {
		const input = container.querySelector<HTMLInputElement>('input[type="file"]');
		if (!input) throw new Error("no file input rendered");
		Object.defineProperty(input, "files", { value: [file], configurable: true });
		fireEvent.change(input);
	}

	it("writes the path, name and type of the chosen file in one update", () => {
		vi.stubGlobal("electronAPI", { getFilePath: () => "/home/ada/portrait.png" });
		const { container, onChange } = editor([{ ...fileRow, src: "", fileName: undefined }]);

		pick(container, new File(["x"], "portrait.png", { type: "image/png" }));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0][0][0]).toMatchObject({
			type: "file",
			src: "/home/ada/portrait.png",
			fileName: "portrait.png",
			contentType: "image/png",
		});
	});

	it("clears the unresolved mark, because the pick is what proves the path", () => {
		vi.stubGlobal("electronAPI", { getFilePath: () => "/home/ada/portrait.png" });
		const { container, onChange } = editor([{ ...fileRow, unresolved: true }]);

		pick(container, new File(["x"], "portrait.png", { type: "image/png" }));

		expect(onChange.mock.calls[0][0][0].unresolved).toBeUndefined();
	});

	it("keeps the row unresolved when there is no path to take", () => {
		// Outside Electron (and for a drag-and-drop of remote content) there is no
		// path - a filename alone is not something the engine can open, and the
		// row has to keep saying so.
		vi.stubGlobal("electronAPI", undefined);
		const { container, onChange } = editor([{ ...fileRow, src: "" }]);

		pick(container, new File(["x"], "portrait.png", { type: "image/png" }));

		expect(onChange.mock.calls[0][0][0]).toMatchObject({ src: "", unresolved: true });
	});
});

describe("what a file row shows", () => {
	it("names the file instead of offering a value field", () => {
		const { container } = editor([fileRow]);
		expect(container.textContent).toContain("a.png");
		// One input for the key; the value cell is the picker, not a second one.
		expect(container.querySelectorAll('input[type="text"]').length).toBeLessThan(2);
	});

	it("marks a row whose path this app never chose", () => {
		const { container } = editor([{ ...fileRow, unresolved: true }]);
		expect(
			container.querySelector('[aria-label="File path not verified on this machine"]')
		).not.toBeNull();

		const { container: resolved } = editor([fileRow]);
		expect(
			resolved.querySelector('[aria-label="File path not verified on this machine"]')
		).toBeNull();
	});
});
