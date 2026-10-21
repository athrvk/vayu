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
 * "Read numbers as numbers" (#2540): offered for a CSV or TSV only, since JSON
 * and JSONL carry their own types, and a toggle re-parses the same file into
 * the rows a run sends. A toggle is not a pick, so it reaches the host through
 * `onCastNumbersChange` and never through `onSelect`, which declares.
 */

import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import DataFilePicker, { type SelectedDataFile } from "./DataFilePicker";

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries: [] as { key: string; value: string }[] } }),
}));

afterEach(cleanup);

/** A host holding the selection the way the dialogs do. */
function Host({
	onSelect,
	onCastNumbersChange,
}: {
	onSelect: (file: SelectedDataFile | null) => void;
	onCastNumbersChange: (file: SelectedDataFile) => void;
}) {
	const [file, setFile] = useState<SelectedDataFile | null>(null);
	return (
		<DataFilePicker
			selected={file}
			onSelect={(next) => {
				setFile(next);
				onSelect(next);
			}}
			onCastNumbersChange={(next) => {
				setFile(next);
				onCastNumbersChange(next);
			}}
			error={null}
			onError={vi.fn()}
			iterations={undefined}
		/>
	);
}

async function pick(name: string, text: string) {
	const onSelect = vi.fn();
	const onCastNumbersChange = vi.fn();
	const view = render(<Host onSelect={onSelect} onCastNumbersChange={onCastNumbersChange} />);
	const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
	fireEvent.change(input, { target: { files: [new File([text], name)] } });
	await waitFor(() => expect(onSelect).toHaveBeenCalled());
	return { onSelect, onCastNumbersChange };
}

const checkbox = () => screen.queryByRole("checkbox", { name: /Read numbers as numbers/ });

describe("Read numbers as numbers", () => {
	it("is offered, off, for a CSV, and a pick reads text", async () => {
		const { onSelect } = await pick("users.csv", 'id,zip\n7,"007"');

		expect(checkbox()).not.toBeNull();
		expect((checkbox() as HTMLInputElement).checked).toBe(false);
		expect(onSelect.mock.calls[0][0].parsed.rows).toEqual([{ id: "7", zip: "007" }]);
		expect(screen.getByText(/Values are read as text/)).toBeTruthy();
	});

	it("is offered for a TSV", async () => {
		await pick("users.tsv", "id\tzip\n7\t007");

		expect(checkbox()).not.toBeNull();
	});

	it.each([
		["users.json", '[{"id": 7}]'],
		["users.jsonl", '{"id": 7}'],
	])("is not offered for %s, which carries its own types", async (name, text) => {
		await pick(name, text);

		expect(screen.getByText(name)).toBeTruthy();
		expect(checkbox()).toBeNull();
	});

	it("re-parses the same file when toggled, keeping its name and hash, without a pick", async () => {
		const { onSelect, onCastNumbersChange } = await pick("users.csv", 'id,zip\n7,"007"');
		const picked: SelectedDataFile = onSelect.mock.calls[0][0];

		fireEvent.click(checkbox()!);

		// Mutation check: re-parse without the option and the rows stay text.
		await waitFor(() => expect(onCastNumbersChange).toHaveBeenCalledTimes(1));
		const toggled: SelectedDataFile = onCastNumbersChange.mock.calls[0][0];
		expect(toggled.parsed.rows).toEqual([{ id: 7, zip: "007" }]);
		expect(toggled.parsed.castNumbers).toBe(true);
		expect(toggled.hash).toBe(picked.hash);
		expect(toggled.fileName).toBe("users.csv");
		expect(onSelect).toHaveBeenCalledTimes(1);

		// The preview follows: the cell and the note both say what will be sent.
		expect((checkbox() as HTMLInputElement).checked).toBe(true);
		expect(screen.getByText(/Numbers are read as numbers/)).toBeTruthy();
		expect(screen.queryByText(/Values are read as text/)).toBeNull();

		fireEvent.click(checkbox()!);
		await waitFor(() => expect(onCastNumbersChange).toHaveBeenCalledTimes(2));
		expect(onCastNumbersChange.mock.calls[1][0].parsed.rows).toEqual([{ id: "7", zip: "007" }]);
	});
});
