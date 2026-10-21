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
 * The picker enforcing the engine's own caps before the run (issue #594).
 *
 * The header comment on `DataFilePicker` claims everything the engine would
 * refuse is refused here first. It was not true of either cap: a 5,000-row CSV
 * previewed cleanly and died at Run with a `400`, and a several-hundred-megabyte
 * file was pulled into a renderer string before anything failed at all.
 *
 * The assertion that matters most is the *source* of the numbers. A hardcoded
 * copy of the engine's limits would refuse a file the user had just raised the
 * setting to allow, and they would have no way to tell which side said no - so
 * the config query is stubbed with values the engine does not seed, and the
 * refusal thresholds have to follow them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";

import { parseDataFile } from "@/services/data-files";
import DataFilePicker from "./DataFilePicker";

const configEntries: { key: string; value: string }[] = [];
vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries: configEntries } }),
}));

function setLimits(rows: number, bytes: number) {
	configEntries.length = 0;
	configEntries.push(
		{ key: "maxScenarioDataRows", value: String(rows) },
		{ key: "maxScenarioDataBytes", value: String(bytes) }
	);
}

/**
 * A parsable file reporting a stated size, without allocating one - the byte
 * cap reads `size` and nothing else, which is the point of checking it there.
 */
function fileOfSize(name: string, bytes: number): File {
	const file = new File(["user\nada"], name);
	Object.defineProperty(file, "size", { value: bytes });
	return file;
}

/** A CSV with `count` data rows under a single `user` column. */
function csvOfRows(count: number): string {
	return `user\n${Array.from({ length: count }, (_, i) => `user-${i}`).join("\n")}`;
}

function renderPicker() {
	const onSelect = vi.fn();
	const onRemove = vi.fn();
	const onError = vi.fn();
	const view = render(
		<DataFilePicker
			selected={null}
			onSelect={onSelect}
			onCastNumbersChange={vi.fn()}
			onRemove={onRemove}
			error={null}
			onError={onError}
			iterations={undefined}
		/>
	);
	const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
	const pick = (file: File) => fireEvent.change(input, { target: { files: [file] } });
	return { onSelect, onRemove, onError, pick };
}

beforeEach(() => {
	setLimits(1000, 16 * 1024 * 1024);
});

describe("the row cap", () => {
	it("refuses a file over it, naming the count and the setting", async () => {
		setLimits(3, 16 * 1024 * 1024);
		const { onSelect, onRemove, onError, pick } = renderPicker();

		pick(new File([csvOfRows(4)], "rows.csv"));

		await waitFor(() =>
			expect(onError).toHaveBeenCalledWith(
				expect.stringMatching(/4 rows, over the 3[\s\S]*maxScenarioDataRows/)
			)
		);
		// Nothing half-chosen: rows the engine would refuse never become a
		// selection the Run button can send. A refusal is not a Remove, though:
		// a host that clears something on Remove must not clear it here.
		expect(onSelect).toHaveBeenCalledWith(null);
		expect(onRemove).not.toHaveBeenCalled();
		expect(onSelect).not.toHaveBeenCalledWith(
			expect.objectContaining({ fileName: "rows.csv" })
		);
	});

	it("follows the fetched value rather than a hardcoded copy of it", async () => {
		// The same file the case above refused, under a raised setting.
		setLimits(4, 16 * 1024 * 1024);
		const { onSelect, onError, pick } = renderPicker();

		pick(new File([csvOfRows(4)], "rows.csv"));

		await waitFor(() =>
			expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ fileName: "rows.csv" }))
		);
		expect(onError).toHaveBeenCalledWith(null);
	});
});

describe("the byte cap", () => {
	it("refuses an oversized file before reading a byte of it", () => {
		setLimits(1000, 1024);
		const { onSelect, onRemove, onError, pick } = renderPicker();

		pick(fileOfSize("huge.csv", 2048));

		// Synchronous, unlike every other refusal here: no FileReader ever ran.
		expect(onError).toHaveBeenCalledWith(
			expect.stringMatching(/2\.0 KB, over the 1\.0 KB[\s\S]*maxScenarioDataBytes/)
		);
		expect(onSelect).toHaveBeenCalledWith(null);
		expect(onRemove).not.toHaveBeenCalled();
	});

	it("follows the fetched value here too", async () => {
		setLimits(1000, 4096);
		const { onSelect, onError, pick } = renderPicker();

		pick(fileOfSize("ok.csv", 2048));

		await waitFor(() =>
			expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ fileName: "ok.csv" }))
		);
		expect(onError).not.toHaveBeenCalledWith(expect.stringContaining("maxScenarioDataBytes"));
	});
});

describe("the file's encoding", () => {
	it("refuses bytes that are not UTF-8 rather than previewing question marks", async () => {
		const { onSelect, onRemove, onError, pick } = renderPicker();
		// `user\nZoë`, with the ë written as Windows-1252.
		const latin1 = new Uint8Array([0x75, 0x73, 0x65, 0x72, 0x0a, 0x5a, 0x6f, 0xeb]);

		pick(new File([latin1], "latin1.csv"));

		await waitFor(() =>
			expect(onError).toHaveBeenCalledWith(expect.stringMatching(/isn't UTF-8/))
		);
		expect(onSelect).toHaveBeenCalledWith(null);
		expect(onRemove).not.toHaveBeenCalled();
	});

	it("reads a UTF-16 export instead of turning it into garbage", async () => {
		const { onSelect, pick } = renderPicker();
		const text = "\uFEFFuser\nada";
		const bytes = new Uint8Array(text.length * 2);
		for (let i = 0; i < text.length; i++) {
			bytes[i * 2] = text.charCodeAt(i) & 0xff;
			bytes[i * 2 + 1] = text.charCodeAt(i) >> 8;
		}

		pick(new File([bytes], "excel.csv"));

		await waitFor(() =>
			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({
					fileName: "excel.csv",
					parsed: expect.objectContaining({
						columns: ["user"],
						rows: [{ user: "ada" }],
					}),
				})
			)
		);
	});
});

describe("the file's content hash (#2051)", () => {
	it("hands the host the SHA-256 of the picked bytes beside the rows", async () => {
		const { onSelect, pick } = renderPicker();

		pick(new File(["user\nada"], "users.csv"));

		// The digest Node's `crypto` answers for the same bytes, which is what
		// the main process records for a re-read of this file.
		await waitFor(() =>
			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({
					fileName: "users.csv",
					hash: "e690cb6f2007dd9d52439eaff4e84ce93f9a1a691c8a0946d17308723839b242",
				})
			)
		);
	});
});

describe("an unterminated quote", () => {
	it("is refused rather than folded into one tall cell", async () => {
		const { onSelect, onRemove, onError, pick } = renderPicker();

		pick(new File(['name\n"alice\nbob\ncarol'], "broken.csv"));

		await waitFor(() =>
			expect(onError).toHaveBeenCalledWith(
				expect.stringMatching(/ends inside a quoted value that starts on line 2/)
			)
		);
		expect(onSelect).toHaveBeenCalledWith(null);
		expect(onRemove).not.toHaveBeenCalled();
	});
});

describe("Remove", () => {
	const selected = {
		fileName: "users.csv",
		parsed: parseDataFile("id\n1", "users.csv"),
		text: "id\n1",
		hash: "0".repeat(64),
	};

	it("drops the selection and tells the host it was a Remove", () => {
		const onSelect = vi.fn();
		const onRemove = vi.fn();
		render(
			<DataFilePicker
				selected={selected}
				onSelect={onSelect}
				onCastNumbersChange={vi.fn()}
				onRemove={onRemove}
				error={null}
				onError={vi.fn()}
				iterations={undefined}
			/>
		);

		fireEvent.click(screen.getByRole("button", { name: /remove/i }));

		expect(onSelect).toHaveBeenCalledWith(null);
		expect(onRemove).toHaveBeenCalledTimes(1);
	});

	it("needs no handler: the hosts that keep a file as a run input pass none", () => {
		const onSelect = vi.fn();
		render(
			<DataFilePicker
				selected={selected}
				onSelect={onSelect}
				onCastNumbersChange={vi.fn()}
				error={null}
				onError={vi.fn()}
				iterations={undefined}
			/>
		);

		fireEvent.click(screen.getByRole("button", { name: /remove/i }));

		expect(onSelect).toHaveBeenCalledWith(null);
	});
});
