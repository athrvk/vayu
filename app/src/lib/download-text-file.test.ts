/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadBlob, downloadTextFile } from "./download-text-file";

interface Click {
	download: string;
	href: string;
	/** Whether the URL was already revoked by the time the anchor was clicked. */
	revokedAtClick: boolean;
}

let clicks: Click[];
let blobs: Map<string, Blob>;
let revoked: string[];

beforeEach(() => {
	clicks = [];
	blobs = new Map();
	revoked = [];
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
		const url = `blob:test-${blobs.size}`;
		blobs.set(url, blob as Blob);
		return url;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
		revoked.push(url);
	});
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement
	) {
		clicks.push({
			download: this.download,
			href: this.href,
			revokedAtClick: revoked.includes(this.href),
		});
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("downloadTextFile without the Electron bridge", () => {
	it("clicks one anchor that carries the file name and the object URL", () => {
		downloadTextFile("{}", "collection.postman.json", "application/json");

		expect(clicks).toHaveLength(1);
		expect(clicks[0].download).toBe("collection.postman.json");
		expect(clicks[0].href).toBe("blob:test-0");
	});

	it("writes the text into a Blob of the given MIME type", async () => {
		downloadTextFile("openapi: 3.1.0\n", "api.yaml", "application/yaml");

		const blob = blobs.get("blob:test-0");
		expect(blob?.type).toBe("application/yaml");
		expect(await blob?.text()).toBe("openapi: 3.1.0\n");
	});

	it("revokes the object URL, and only after the click", () => {
		downloadTextFile("x", "response.txt", "text/plain");

		expect(revoked).toEqual(["blob:test-0"]);
		expect(clicks[0].revokedAtClick).toBe(false);
	});

	it("resolves saved, since an anchor cannot report a cancel", async () => {
		await expect(downloadTextFile("x", "response.txt", "text/plain")).resolves.toEqual({
			outcome: "saved",
		});
	});
});

/*
 * Mutation check: resolve `saved` whatever the bridge answered, or let its
 * rejection escape, and the cancelled and failed cases red.
 */
describe("downloadTextFile and downloadBlob through the Electron bridge", () => {
	function stubBridge(saveFile: ReturnType<typeof vi.fn>) {
		vi.stubGlobal("electronAPI", { saveFile });
		return saveFile;
	}

	it("hands main the text and the name, and clicks no anchor", async () => {
		const saveFile = stubBridge(
			vi.fn().mockResolvedValue({ outcome: "saved", path: "/d/a.json" })
		);

		await expect(downloadTextFile("{}", "a.json", "application/json")).resolves.toEqual({
			outcome: "saved",
		});

		expect(saveFile).toHaveBeenCalledWith("{}", "a.json");
		expect(clicks).toEqual([]);
	});

	it("hands main a blob's exact bytes", async () => {
		const saveFile = stubBridge(
			vi.fn().mockResolvedValue({ outcome: "saved", path: "/d/b.bin" })
		);
		const bytes = new Uint8Array([0, 255, 128, 10]);

		await downloadBlob(new Blob([bytes], { type: "application/octet-stream" }), "b.bin");

		const [sent, name] = saveFile.mock.calls[0] as [Uint8Array, string];
		expect(name).toBe("b.bin");
		expect(Array.from(sent)).toEqual([0, 255, 128, 10]);
		expect(clicks).toEqual([]);
	});

	it("resolves cancelled when the user dismisses the dialog", async () => {
		stubBridge(vi.fn().mockResolvedValue({ outcome: "cancelled" }));

		await expect(downloadTextFile("x", "a.txt", "text/plain")).resolves.toEqual({
			outcome: "cancelled",
		});
	});

	it("resolves failed with main's sentence when the write fails", async () => {
		stubBridge(
			vi.fn().mockResolvedValue({ outcome: "failed", message: "EACCES: permission denied" })
		);

		await expect(downloadTextFile("x", "a.txt", "text/plain")).resolves.toEqual({
			outcome: "failed",
			message: "EACCES: permission denied",
		});
	});

	it("resolves failed, rather than rejecting, when main refuses the call", async () => {
		stubBridge(
			vi
				.fn()
				.mockRejectedValue(new Error("Refused: files are saved only from the Vayu window."))
		);

		await expect(downloadBlob(new Blob(["x"]), "a.bin")).resolves.toEqual({
			outcome: "failed",
			message: "Refused: files are saved only from the Vayu window.",
		});
	});
});
