/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadTextFile } from "./download-text-file";

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
});

describe("downloadTextFile", () => {
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
});
