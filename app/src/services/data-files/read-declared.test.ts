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
 * Re-reading the declared file (issue #727).
 *
 * The three surfaces that do it - the Run dialog's pre-fill, Send-with-row and
 * the Data tab - share this one function precisely so they cannot decode a file
 * differently from each other, or from the picker that first read it. So what is
 * asserted here is the part a caller must be able to rely on without repeating
 * it: the bytes go through the *same* decoder (a UTF-16 CSV is not garbage), the
 * name comes back from disk rather than from the caller's memory of it, and the
 * two failures a caller has to tell apart are two different errors.
 *
 * And the refusal the re-read used to skip (issue #751): the picker turns down a
 * hand-picked file over `maxScenarioDataRows`, so a remembered path that has
 * grown past it must be turned down here rather than previewed and refused by
 * `POST /runs` afterwards.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { DataFileError } from "./errors";
import {
	NoDataFileBridgeError,
	canReadDeclaredDataFile,
	readDeclaredDataFile,
} from "./read-declared";

/** Bytes as the `readDataFile` bridge hands them over. */
function bridge(text: string, fileName: string, encoding: "utf-8" | "utf-16le" = "utf-8") {
	const bytes =
		encoding === "utf-8"
			? new TextEncoder().encode(text)
			: (() => {
					const withBom = `\ufeff${text}`;
					const out = new Uint8Array(withBom.length * 2);
					for (let i = 0; i < withBom.length; i++) {
						const code = withBom.charCodeAt(i);
						out[i * 2] = code & 0xff;
						out[i * 2 + 1] = code >> 8;
					}
					return out;
				})();
	return vi.fn(() => Promise.resolve({ bytes, fileName }));
}

/** A cap no case below is testing, so the read turns on the file alone. */
const LIMITS = { maxRows: 1000 };

/** A CSV with `count` data rows under a single `user` column. */
function csvOfRows(count: number): string {
	return `user\n${Array.from({ length: count }, (_, i) => `user-${i}`).join("\n")}`;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("canReadDeclaredDataFile", () => {
	it("is false outside Electron, where a remembered path can never be opened", () => {
		vi.stubGlobal("electronAPI", undefined);
		expect(canReadDeclaredDataFile()).toBe(false);
	});

	it("is true with the bridge present", () => {
		vi.stubGlobal("electronAPI", { readDataFile: () => Promise.resolve() });
		expect(canReadDeclaredDataFile()).toBe(true);
	});
});

describe("readDeclaredDataFile", () => {
	it("parses the file and reports the name disk gave, not the one asked for", async () => {
		const read = bridge("id,email\n1,a@b.c", "users-renamed.csv");
		vi.stubGlobal("electronAPI", { readDataFile: read });

		const file = await readDeclaredDataFile("/home/u/users.csv", LIMITS);

		expect(read).toHaveBeenCalledWith("/home/u/users.csv");
		expect(file.fileName).toBe("users-renamed.csv");
		expect(file.path).toBe("/home/u/users.csv");
		expect(file.parsed.columns).toEqual(["id", "email"]);
		expect(file.parsed.rows).toEqual([{ id: "1", email: "a@b.c" }]);
	});

	it("decodes UTF-16 the way the picker does, so a re-read cannot disagree with the pick", async () => {
		// The whole reason this is one function: `TextDecoder("utf-8")` on these
		// bytes yields NUL-riddled columns that still parse, which is the silent
		// wrong-request failure `decode.ts` exists to remove.
		vi.stubGlobal("electronAPI", {
			readDataFile: bridge("id,city\n1,Köln", "excel.csv", "utf-16le"),
		});

		const file = await readDeclaredDataFile("/home/u/excel.csv", LIMITS);

		expect(file.parsed.columns).toEqual(["id", "city"]);
		expect(file.parsed.rows[0].city).toBe("Köln");
	});

	it("rejects with NoDataFileBridgeError outside Electron", async () => {
		vi.stubGlobal("electronAPI", undefined);
		await expect(readDeclaredDataFile("/home/u/users.csv", LIMITS)).rejects.toBeInstanceOf(
			NoDataFileBridgeError
		);
	});

	it("passes the bridge's own failure through, so the caller can show it verbatim", async () => {
		vi.stubGlobal("electronAPI", {
			readDataFile: () => Promise.reject(new Error("ENOENT: no such file or directory")),
		});
		await expect(readDeclaredDataFile("/home/u/gone.csv", LIMITS)).rejects.toThrow(/ENOENT/);
	});

	it("rejects a file that no longer parses with the parser's own message", async () => {
		vi.stubGlobal("electronAPI", { readDataFile: bridge("id,id\n1,2", "dupes.csv") });
		await expect(readDeclaredDataFile("/home/u/dupes.csv", LIMITS)).rejects.toBeInstanceOf(
			DataFileError
		);
	});
});

describe("the row cap on a re-read", () => {
	it("refuses a remembered file over it, naming the count and the setting", async () => {
		vi.stubGlobal("electronAPI", { readDataFile: bridge(csvOfRows(4), "grown.csv") });

		// The picker's sentence, not a second one: a user who has read
		// "raise maxScenarioDataRows" once should not meet a paraphrase of it.
		await expect(readDeclaredDataFile("/home/u/grown.csv", { maxRows: 3 })).rejects.toThrow(
			/4 rows, over the 3[\s\S]*maxScenarioDataRows/
		);
		// A `DataFileError`, which is what every caller's catch already shows
		// verbatim beside a picker that is still usable.
		await expect(
			readDeclaredDataFile("/home/u/grown.csv", { maxRows: 3 })
		).rejects.toBeInstanceOf(DataFileError);
	});

	it("reads the cap it was handed, so raising the setting accepts the same file", async () => {
		// The file the case above refused, under a setting the user has raised.
		// The cap cannot be a seed captured anywhere: this is the whole reason it
		// travels in as an argument.
		vi.stubGlobal("electronAPI", { readDataFile: bridge(csvOfRows(4), "grown.csv") });

		const file = await readDeclaredDataFile("/home/u/grown.csv", { maxRows: 4 });

		expect(file.parsed.rows).toHaveLength(4);
	});
});
