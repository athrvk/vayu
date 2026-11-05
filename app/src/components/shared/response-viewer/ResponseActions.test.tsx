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
 * Download writes what the server sent (issue #2458).
 *
 * It used to write the pane's text as `text/plain`, so a PDF or a PNG came out
 * as whatever string the body had been turned into. A body the engine sent as
 * base64 carries its bytes as `rawBytes`, and Download hands exactly those to
 * the Blob under the response's Content-Type. Copy has no text to take from a
 * body with no text view, and says so rather than copying base64.
 *
 * A failed save is a toast and a cancelled one is silent (#3246). Mutation
 * check: drop the `failed` test before the toast and the cancelled case reds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { downloadBlob, downloadTextFile } from "@/lib/download-text-file";
import { useToastStore } from "@/stores";
import type { ResponseBytes } from "@/modules/request-builder/utils/response-bytes";
import { ResponseActions } from "./ResponseActions";

// The real downloader, spied so a case can answer for the save dialog (#3246).
vi.mock("@/lib/download-text-file", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/download-text-file")>();
	return {
		...real,
		downloadBlob: vi.fn(real.downloadBlob),
		downloadTextFile: vi.fn(real.downloadTextFile),
	};
});

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe]);

let blobs: Blob[];
let downloads: string[];

beforeEach(() => {
	vi.mocked(downloadBlob).mockClear();
	vi.mocked(downloadTextFile).mockClear();
	useToastStore.setState({ toasts: [] });
	blobs = [];
	downloads = [];
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
		blobs.push(blob as Blob);
		return `blob:test-${blobs.length}`;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement
	) {
		downloads.push(this.download);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function renderActions(props: Parameters<typeof ResponseActions>[0]) {
	return render(
		<TooltipProvider>
			<ResponseActions {...props} />
		</TooltipProvider>
	);
}

const download = () => fireEvent.click(screen.getByRole("button", { name: "Download response" }));
const copyButton = () => screen.getByRole("button", { name: "Copy response" });

describe("Download", () => {
	it("writes a base64 body's exact bytes, typed and named by its Content-Type", async () => {
		const rawBytes: ResponseBytes = { data: PDF, isText: false };
		renderActions({ content: "", rawBytes, contentType: "application/pdf" });

		download();

		expect(blobs).toHaveLength(1);
		expect(blobs[0].type).toBe("application/pdf");
		expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(PDF);
		expect(downloads[0]).toMatch(/^response-\d+\.pdf$/);
	});

	it("writes the bytes, not their decoding, for text that was not UTF-8", async () => {
		const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
		renderActions({
			content: "café",
			rawBytes: { data: latin1, isText: true },
			contentType: "text/plain; charset=iso-8859-1",
		});

		download();

		expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(latin1);
		expect(downloads[0]).toMatch(/\.txt$/);
	});

	it("still writes a utf8 body as its text", async () => {
		renderActions({ content: '{"ok":true}', contentType: "application/json" });

		download();

		expect(await blobs[0].text()).toBe('{"ok":true}');
		expect(downloads[0]).toMatch(/^response-\d+\.json$/);
	});

	// The extension comes from the response's Content-Type, not a detected body
	// type: `text/javascript` is detected as javascript but used to save as
	// `.javascript` (#3140).
	it.each([
		["text/javascript; charset=utf-8", "js"],
		["text/html", "html"],
		["text/plain", "txt"],
		["", "txt"],
		["application/problem+json", "json"],
		["application/vnd.api+json", "json"],
		["application/ld+json", "json"],
		["application/atom+xml", "xml"],
		["application/xhtml+xml", "xml"],
		// No usable subtype: `bin` is for bytes, so a readable body falls back to `.txt`.
		["application/vnd.ms-excel", "txt"],
	])("names a text body of type %j .%s", (contentType, extension) => {
		renderActions({ content: "body", contentType });

		download();

		expect(downloads[0]).toMatch(new RegExp(`^response-\\d+\\.${extension}$`));
	});

	it("names a text body .txt when no content type is given at all", () => {
		renderActions({ content: "body" });

		download();

		expect(downloads[0]).toMatch(/^response-\d+\.txt$/);
	});
});

describe("what Download says about the save", () => {
	const toasts = () => useToastStore.getState().toasts.map((t) => [t.message, t.variant]);

	it("says nothing when the user cancels the save dialog", async () => {
		let answerDialog!: (outcome: { outcome: "cancelled" }) => void;
		vi.mocked(downloadTextFile).mockReturnValueOnce(
			new Promise((resolve) => (answerDialog = resolve))
		);
		renderActions({ content: "body", contentType: "text/plain" });

		download();
		await act(async () => answerDialog({ outcome: "cancelled" }));

		expect(toasts()).toEqual([]);
	});

	it("names the file and the reason when a byte body's save fails", async () => {
		vi.mocked(downloadBlob).mockResolvedValueOnce({ outcome: "failed", message: "Disk full" });
		renderActions({
			content: "",
			rawBytes: { data: PDF, isText: false },
			contentType: "application/pdf",
		});

		download();

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(toasts()[0][0]).toMatch(/^Couldn't save response-\d+\.pdf - Disk full$/);
		expect(toasts()[0][1]).toBe("error");
	});
});

describe("Copy", () => {
	it("is off for bytes with no text view, behind a reason", () => {
		renderActions({ content: "", rawBytes: { data: PDF, isText: false } });

		expect(copyButton()).toBeDisabled();
		expect(copyButton().closest('[data-slot="disabled-hint"]')).not.toBeNull();
	});

	it("stays on for a decoded text body", () => {
		renderActions({ content: "café", rawBytes: { data: PDF, isText: true } });

		expect(copyButton()).toBeEnabled();
	});
});
