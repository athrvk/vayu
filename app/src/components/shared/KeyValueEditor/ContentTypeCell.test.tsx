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
 * The form-data `Content type` column (#3022), through the editor that mounts
 * it. What matters is the row the list becomes: a typed value sets the part's
 * `contentType`, an emptied field drops the member (a stored "" would be a
 * different request from none), and a file part's picked type is editable.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import KeyValueEditor from "./index";
import { contentTypeExtra, withContentType } from "./ContentTypeCell";
import type { KeyValueItem } from "@/types";

function editor(items: KeyValueItem[]) {
	const onChange = vi.fn<(items: KeyValueItem[]) => void>();
	const { container } = render(
		<TooltipProvider>
			<KeyValueEditor
				items={items}
				onChange={onChange}
				allowFiles
				rowExtra={contentTypeExtra()}
			/>
		</TooltipProvider>
	);
	return { container, onChange };
}

function contentTypeInput(container: HTMLElement, key: string): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>(
		`input[aria-label="Content type of ${key}"]`
	);
	if (!input) throw new Error("no Content type field rendered - the column markup changed");
	return input;
}

const entity: KeyValueItem = { id: "r1", key: "entity_content", value: "{}", enabled: true };
const upload: KeyValueItem = {
	id: "r2",
	key: "VersionData",
	value: "",
	enabled: true,
	type: "file",
	src: "/tmp/Q1.pdf",
	fileName: "Q1.pdf",
	contentType: "application/pdf",
};

function lastRows(onChange: ReturnType<typeof editor>["onChange"]): KeyValueItem[] {
	const calls = onChange.mock.calls;
	return calls[calls.length - 1]![0];
}

const rowOf = (rows: KeyValueItem[], id: string) => rows.find((row) => row.id === id);

describe("the Content type column", () => {
	it("names the column and offers a field on a text part", () => {
		const { container } = editor([entity]);
		expect(container.textContent).toContain("Content type");
		expect(contentTypeInput(container, "entity_content").value).toBe("");
	});

	it("sets a text part's type, as Salesforce's entity_content needs", () => {
		const { container, onChange } = editor([entity]);
		fireEvent.change(contentTypeInput(container, "entity_content"), {
			target: { value: "application/json" },
		});

		expect(rowOf(lastRows(onChange), "r1")?.contentType).toBe("application/json");
	});

	it("shows and edits the type a picked file carries", () => {
		const { container, onChange } = editor([upload]);
		const input = contentTypeInput(container, "VersionData");
		expect(input.value).toBe("application/pdf");

		fireEvent.change(input, { target: { value: "application/octet-stream" } });
		expect(rowOf(lastRows(onChange), "r2")?.contentType).toBe("application/octet-stream");
	});

	it("drops the member when the field is emptied", () => {
		const { container, onChange } = editor([upload]);
		fireEvent.change(contentTypeInput(container, "VersionData"), { target: { value: "" } });

		const row = rowOf(lastRows(onChange), "r2");
		expect(row).toBeDefined();
		expect("contentType" in row!).toBe(false);
		expect(row?.src).toBe("/tmp/Q1.pdf");
	});
});

describe("withContentType", () => {
	it("sets, replaces and removes the member without touching the rest of the row", () => {
		const set = withContentType(entity, "application/json");
		expect(set).toEqual({ ...entity, contentType: "application/json" });
		expect(withContentType(set, "text/plain").contentType).toBe("text/plain");
		expect(withContentType(set, "")).toEqual(entity);
	});
});
