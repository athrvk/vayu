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
 * The remembered file against the run's (#2051, #2057). With the hash bridge the
 * hook compares the run's hash with the file's digest as it is now, and reports
 * a file the main process says is gone as `missing`; without one, a browser
 * build, it compares with the hash the app last recorded for the collection and
 * has no way to say `missing`.
 *
 * Mutation checks: read the location of a different collection id, or drop the
 * `undefined` guard, and the "other collection" and "no collection" cases fail;
 * compare against the stored hash while bridged and the "edited on disk" cases
 * fail; treat a rejected hash as missing or changed and the "refused" case
 * fails; ignore the reply's status and the "missing" cases fail; drop the
 * path check on the answer and the "path change" case fails; leave the
 * binding's `castNumbers` out of the classification and the "reading" cases
 * fail (#2636).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDataFileStore } from "@/stores";
import type { DataFileHashReply } from "@/types/electron";
import { useDataFileStatus } from "./useDataFileStatus";
import { bindDataFile } from "@/test/file-bindings.testkit";

const A = "a".repeat(64);
const B = "b".repeat(64);

const found = (hash: string): DataFileHashReply => ({ status: "found", hash });
const MISSING: DataFileHashReply = { status: "missing" };

function remember(collectionId: string, hash: string | undefined, castNumbers?: boolean) {
	bindDataFile(collectionId, {
		path: "/data/users.csv",
		fileName: "users.csv",
		...(hash ? { hash } : {}),
		...(castNumbers === undefined ? {} : { castNumbers }),
	});
}

beforeEach(() => {
	vi.unstubAllGlobals();
	useDataFileStore.setState({ locations: {} });
});

describe("useDataFileStatus without the hash bridge (the stored hash)", () => {
	it("is changed when the collection's remembered hash differs from the run's", () => {
		remember("col_1", B);
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		expect(result.current).toBe("changed");
	});

	it("is unchanged when the hashes match", () => {
		remember("col_1", A);
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		expect(result.current).toBe("unchanged");
	});

	it("is unknown for a location remembered before hashes were recorded", () => {
		remember("col_1", undefined);
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		expect(result.current).toBe("unknown");
	});

	it("is unknown for a run recorded before hashes", () => {
		remember("col_1", B);
		const { result } = renderHook(() => useDataFileStatus("col_1", undefined, undefined));
		expect(result.current).toBe("unknown");
	});

	it("is unknown when only another collection remembers a different file", () => {
		remember("col_2", B);
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		expect(result.current).toBe("unknown");
	});

	it("is unknown without a collection to ask", () => {
		remember("col_1", B);
		const { result } = renderHook(() => useDataFileStatus(undefined, A, undefined));
		expect(result.current).toBe("unknown");
	});

	it("follows the store when the binding records a new hash", () => {
		remember("col_1", A);
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		expect(result.current).toBe("unchanged");

		act(() => remember("col_1", B));
		expect(result.current).toBe("changed");
	});
});

describe("useDataFileStatus: the binding's number reading against the run's (#2636)", () => {
	it("without the bridge, is readingChanged when the binding casts and the run did not", () => {
		remember("col_1", A, true);
		const { result } = renderHook(() => useDataFileStatus("col_1", A, false));
		expect(result.current).toBe("readingChanged");
	});

	it("without the bridge, is readingChanged when the run cast and the binding no longer does", () => {
		remember("col_1", A);
		const { result } = renderHook(() => useDataFileStatus("col_1", A, true));
		expect(result.current).toBe("readingChanged");
	});

	it("without the bridge, is unchanged when the reading matches or both are off", () => {
		remember("col_1", A, true);
		expect(renderHook(() => useDataFileStatus("col_1", A, true)).result.current).toBe(
			"unchanged"
		);
		remember("col_1", A);
		expect(renderHook(() => useDataFileStatus("col_1", A, undefined)).result.current).toBe(
			"unchanged"
		);
	});

	it("with the bridge, reads the binding's flag beside the hash of the file now", async () => {
		remember("col_1", B, true);
		vi.stubGlobal("electronAPI", { hashDataFile: vi.fn(async () => found(A)) });
		const { result } = renderHook(() => useDataFileStatus("col_1", A, false));
		await waitFor(() => expect(result.current).toBe("readingChanged"));
	});

	it("with the bridge, lets different bytes win over a different reading", async () => {
		remember("col_1", A, true);
		vi.stubGlobal("electronAPI", { hashDataFile: vi.fn(async () => found(B)) });
		const { result } = renderHook(() => useDataFileStatus("col_1", A, false));
		await waitFor(() => expect(result.current).toBe("changed"));
	});
});

describe("useDataFileStatus with the hash bridge (the file as it is now)", () => {
	const stubHash = (impl: (path: string) => Promise<DataFileHashReply>) => {
		const hashDataFile = vi.fn(impl);
		vi.stubGlobal("electronAPI", { hashDataFile });
		return hashDataFile;
	};

	it("is changed when the file was edited on disk after the run, whatever the store says", async () => {
		remember("col_1", A);
		const hashDataFile = stubHash(async () => found(B));
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		await waitFor(() => expect(result.current).toBe("changed"));
		expect(hashDataFile).toHaveBeenCalledWith("/data/users.csv");
	});

	it("is unchanged when the file on disk still matches the run, even over a stale stored hash", async () => {
		remember("col_1", B);
		stubHash(async () => found(A));
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		await waitFor(() => expect(result.current).toBe("unchanged"));
	});

	it("is unknown while the hash is in flight", () => {
		remember("col_1", B);
		stubHash(() => new Promise<DataFileHashReply>(() => {}));
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		expect(result.current).toBe("unknown");
	});

	it("is missing when the main process says the file is no longer at its path", async () => {
		remember("col_1", A);
		stubHash(async () => MISSING);
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		await waitFor(() => expect(result.current).toBe("missing"));
	});

	it("is missing for a run recorded before hashes, which names a file that has moved all the same", async () => {
		remember("col_1", A);
		stubHash(async () => MISSING);
		const { result } = renderHook(() => useDataFileStatus("col_1", undefined, undefined));
		await waitFor(() => expect(result.current).toBe("missing"));
	});

	it("is unknown, not missing, when the hash is refused for another reason", async () => {
		remember("col_1", B);
		const hashDataFile = stubHash(async () => {
			throw new Error('Vayu only opens data files (.csv), and this one is ".exe".');
		});
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		await waitFor(() => expect(hashDataFile).toHaveBeenCalled());
		await act(async () => {});
		expect(result.current).toBe("unknown");
	});

	it("asks nothing without a remembered location", () => {
		const hashDataFile = stubHash(async () => found(B));
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		expect(result.current).toBe("unknown");
		expect(hashDataFile).not.toHaveBeenCalled();
	});

	it("hashes again when the window regains focus, and notices a file that has gone", async () => {
		remember("col_1", A);
		let onDisk: DataFileHashReply = found(A);
		const hashDataFile = stubHash(async () => onDisk);
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		await waitFor(() => expect(result.current).toBe("unchanged"));
		expect(hashDataFile).toHaveBeenCalledTimes(1);

		onDisk = found(B);
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await waitFor(() => expect(result.current).toBe("changed"));

		onDisk = MISSING;
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await waitFor(() => expect(result.current).toBe("missing"));
	});

	it("discards the answer for a previous path when the remembered path changes", async () => {
		remember("col_1", A);
		let release: (reply: DataFileHashReply) => void = () => {};
		stubHash((path) =>
			path === "/data/users.csv"
				? Promise.resolve(MISSING)
				: new Promise<DataFileHashReply>((resolve) => {
						release = resolve;
					})
		);
		const { result } = renderHook(() => useDataFileStatus("col_1", A, undefined));
		await waitFor(() => expect(result.current).toBe("missing"));

		act(() =>
			bindDataFile("col_1", {
				path: "/data/other.csv",
				fileName: "other.csv",
			})
		);
		expect(result.current).toBe("unknown");

		await act(async () => release(found(A)));
		expect(result.current).toBe("unchanged");
	});
});
